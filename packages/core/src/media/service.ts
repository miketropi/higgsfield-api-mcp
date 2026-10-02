import { basename } from 'node:path';
import type {
  Clock,
  LoggerPort,
  MediaAsset,
  MediaIdentity,
  MediaInput,
  MediaReference,
  MediaService,
  MediaType,
  MetricsPort,
  ObjectStore,
  ProviderFactory,
  ProviderMediaUpload,
  RequestContext
} from '../contracts.js';
import type { JobRepository } from '../jobs/repository.js';
import { GatewayError } from '../errors.js';
import { newId, sha256Hex } from '../ids.js';
import { safeUrlForLogging } from '../redact.js';
import { createLocalFileReader } from './local-files.js';
import { mediaTypeFromExtension } from './mime.js';
import { assertRemoteUrlSyntax, createRemoteFetcher } from './remote-fetch.js';

export interface MediaServiceConfig {
  /** Already validated by `@higgsfield-mcp/config`. Empty means deny-all. */
  allowedPaths: string[];
  assetMode: 'passthrough' | 'managed';
  maxUploadBytes: number;
  downloadTimeoutMs: number;
  maxRedirects: number;
  signedUrlTtlSeconds: number;
  /** stdio only. Remote HTTP must reject every path/file input even with roots configured. */
  localFileAccess: boolean;
}

export interface MediaServiceOptions {
  repository: JobRepository;
  providerFactory: ProviderFactory;
  clock: Clock;
  logger: LoggerPort;
  metrics: MetricsPort;
  config: MediaServiceConfig;
  objectStore?: ObjectStore | undefined;
  /** Test seams; production uses the hardened defaults. */
  fetchImpl?: typeof fetch | undefined;
  resolveHost?: ((hostname: string) => Promise<string[]>) | undefined;
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4'
};

/**
 * Sanitizes one path segment of an object key. Anything outside the safe set is
 * dropped, and a value that had to be changed keeps a digest suffix so two
 * different identifiers can never collapse onto the same key.
 */
function keySegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '').replace(/^[.-]+/, '');
  if (safe.length > 0 && safe === value) return safe.slice(0, 120);
  return `${safe.slice(0, 100)}-${sha256Hex(value).slice(0, 16)}`;
}

/**
 * Logical object key for a managed asset: `${tenantId}/${assetId}`. The object
 * store prepends its own configured prefix, producing
 * `${prefix}/${tenantId}/${assetId}`.
 */
export function managedObjectKey(tenantId: string, assetId: string): string {
  return `${keySegment(tenantId)}/${keySegment(assetId)}`;
}

function requireTenant(context: RequestContext): string {
  if (context.tenantId === undefined || context.tenantId.length === 0) {
    throw new GatewayError('INTERNAL_ERROR', 'Resolved request context has no tenant.');
  }
  return context.tenantId;
}

/** Provider-facing filename: no directory parts, no control characters. */
function safeFilename(candidate: string, mimeType: string): string {
  const extension = MIME_EXTENSIONS[mimeType] ?? 'bin';
  const cleaned = candidate.replace(/[^A-Za-z0-9_.-]/g, '').replace(/^\.+/, '');
  if (cleaned === '') return `upload.${extension}`;
  const trimmed = cleaned.slice(0, 64);
  return trimmed.includes('.') ? trimmed : `${trimmed}.${extension}`;
}

function reconcileMediaType(declared: MediaType | undefined, detected: MediaType): MediaType {
  if (declared !== undefined && declared !== detected) {
    throw new GatewayError('INVALID_INPUT', 'The declared media type does not match the media content.');
  }
  return declared ?? detected;
}

/**
 * Runtime guard for the two `MediaInput.source` shapes. The union is closed in
 * TypeScript, but tool handlers and adapters reach this service with values
 * parsed from JSON, so an unexpected shape must fail as `INVALID_INPUT` rather
 * than as a filesystem or URL parse error.
 */
function assertSource(source: { path?: string | undefined; url?: string | undefined }): { path: string } | { url: string } {
  const path = typeof source.path === 'string' && source.path !== '' ? source.path : undefined;
  const url = typeof source.url === 'string' && source.url !== '' ? source.url : undefined;
  if (path === undefined && url === undefined) {
    throw new GatewayError('INVALID_INPUT', 'A media source must provide a path or a url.');
  }
  if (path !== undefined && url !== undefined) {
    throw new GatewayError('INVALID_INPUT', 'A media source must provide exactly one of path or url.');
  }
  if (path !== undefined) return { path };
  if (url !== undefined) return { url };
  throw new GatewayError('INVALID_INPUT', 'A media source must provide exactly one of path or url.');
}

/** Same guard for a media reference whose discriminator is not one of the three shapes. */
function assertReferenceSource(reference: MediaReference): { path: string } | { url: string } {
  const raw = reference as { type?: unknown; path?: unknown; url?: unknown };
  if (raw.type === 'file' && typeof raw.path === 'string' && raw.path !== '') return { path: raw.path };
  if (raw.type === 'url' && typeof raw.url === 'string' && raw.url !== '') return { url: raw.url };
  throw new GatewayError('INVALID_INPUT', 'Unsupported media reference.');
}

interface IngestedMedia {
  bytes: Uint8Array;
  mimeType: string;
  mediaType: MediaType;
  filename: string;
}

/**
 * The single resolver for caller media. Nothing else in the gateway may read a
 * local file, download a caller URL, or copy provider bytes: adapters and tool
 * handlers receive already-validated bytes or provider URLs.
 */
export function createMediaService(options: MediaServiceOptions): MediaService {
  const config = options.config;
  const objectStore = options.objectStore;
  if (config.assetMode === 'managed' && objectStore === undefined) {
    throw new GatewayError('INTERNAL_ERROR', 'Managed asset mode requires an object store.');
  }

  const repository = options.repository;
  const clock = options.clock;
  const metrics = options.metrics;
  const logger = options.logger.child({ component: 'media' });
  const files = createLocalFileReader({
    allowedPaths: config.allowedPaths,
    localFileAccess: config.localFileAccess,
    maxBytes: config.maxUploadBytes,
    logger
  });
  const remote = createRemoteFetcher({
    maxBytes: config.maxUploadBytes,
    downloadTimeoutMs: config.downloadTimeoutMs,
    maxRedirects: config.maxRedirects,
    logger,
    fetchImpl: options.fetchImpl,
    resolveHost: options.resolveHost
  });

  const expiresAtIso = (ttlSeconds: number): string => new Date(clock.now().getTime() + ttlSeconds * 1000).toISOString();

  const ingest = async (
    source: { path: string } | { url: string },
    declaredMediaType: MediaType | undefined,
    signal: AbortSignal | undefined,
    context: RequestContext
  ): Promise<IngestedMedia> => {
    const checked = assertSource(source);
    if ('path' in checked) {
      const file = await files.read(checked.path);
      const mediaType = reconcileMediaType(declaredMediaType, file.mediaType);
      metrics.mediaUploadBytes('in', file.size);
      logger.debug(
        { requestId: context.requestId, bytes: file.size, mimeType: file.mimeType },
        'Read media from an allowed local path.'
      );
      return { bytes: file.bytes, mimeType: file.mimeType, mediaType, filename: safeFilename(basename(file.realPath), file.mimeType) };
    }

    const media = await remote.fetchMedia(checked.url, signal);
    const mediaType = reconcileMediaType(declaredMediaType, media.mediaType);
    metrics.mediaUploadBytes('in', media.bytes.byteLength);
    logger.debug(
      { requestId: context.requestId, url: safeUrlForLogging(checked.url), bytes: media.bytes.byteLength, mimeType: media.mimeType },
      'Downloaded media from a caller URL.'
    );
    return {
      bytes: media.bytes,
      mimeType: media.mimeType,
      mediaType,
      filename: safeFilename(basename(new URL(checked.url).pathname), media.mimeType)
    };
  };

  const signKey = async (key: string): Promise<string> => {
    if (objectStore === undefined) {
      throw new GatewayError('INTERNAL_ERROR', 'Managed asset mode requires an object store.');
    }
    try {
      return await objectStore.signedGetUrl(key, config.signedUrlTtlSeconds);
    } catch (error) {
      throw new GatewayError('INTERNAL_ERROR', 'Signing a managed asset URL failed.', { cause: error });
    }
  };

  /** Copies bytes into managed storage. Runs before the asset row exists. */
  const copyToManagedStore = async (
    tenantId: string,
    assetId: string,
    bytes: Uint8Array,
    mimeType: string
  ): Promise<{ key: string; url: string; expiresAt: string }> => {
    if (objectStore === undefined) {
      throw new GatewayError('INTERNAL_ERROR', 'Managed asset mode requires an object store.');
    }
    const key = managedObjectKey(tenantId, assetId);
    try {
      await objectStore.put(key, bytes, mimeType);
    } catch (error) {
      // The copy is independent of generation: a failure is reported as
      // retryable and never triggers a provider re-submission.
      throw new GatewayError('MEDIA_UPLOAD_FAILED', 'Copying the media into managed storage failed.', { cause: error });
    }
    return { key, url: await signKey(key), expiresAt: expiresAtIso(config.signedUrlTtlSeconds) };
  };

  const publish = async (media: IngestedMedia, context: RequestContext, signal: AbortSignal | undefined): Promise<MediaAsset> => {
    const tenantId = requireTenant(context);
    const provider = await options.providerFactory.forContext(context);

    let upload: ProviderMediaUpload;
    try {
      upload = await provider.uploadMedia({
        bytes: media.bytes,
        filename: media.filename,
        mimeType: media.mimeType,
        mediaType: media.mediaType,
        signal
      });
      metrics.providerRequest(provider.id, 'media-upload', 'ok');
    } catch (error) {
      metrics.providerRequest(provider.id, 'media-upload', 'error');
      metrics.providerError(provider.id, error instanceof GatewayError ? error.code : 'MEDIA_UPLOAD_FAILED');
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('MEDIA_UPLOAD_FAILED', 'The provider rejected the media upload.', { cause: error });
    }
    metrics.mediaUploadBytes('out', media.bytes.byteLength);

    const assetId = newId('asset');
    const asset: MediaAsset = {
      id: assetId,
      tenantId,
      provider: upload.provider,
      mediaType: media.mediaType,
      mimeType: media.mimeType,
      size: upload.size,
      url: upload.url,
      createdAt: clock.now().toISOString(),
      origin: 'upload'
    };
    if (upload.expiresAt !== undefined) asset.urlExpiresAt = upload.expiresAt;
    if (context.workspaceId !== undefined) asset.workspaceId = context.workspaceId;

    if (config.assetMode === 'managed') {
      const managed = await copyToManagedStore(tenantId, assetId, media.bytes, media.mimeType);
      asset.storageKey = managed.key;
      asset.url = managed.url;
      asset.urlExpiresAt = managed.expiresAt;
    }

    // The row is written only after every byte-moving step succeeded, so a
    // failed copy leaves no dangling asset.
    await repository.transaction(async (tx) => {
      await tx.insertAsset(asset);
    });
    logger.info(
      { requestId: context.requestId, assetId, bytes: media.bytes.byteLength, origin: asset.origin, mode: config.assetMode },
      'Media asset stored.'
    );
    return asset;
  };

  /** Managed assets are re-signed on every read; the stored row keeps the newest URL. */
  const resignIfManaged = async (asset: MediaAsset): Promise<MediaAsset> => {
    if (config.assetMode !== 'managed' || objectStore === undefined || asset.storageKey === undefined) return asset;
    const url = await signKey(asset.storageKey);
    const urlExpiresAt = expiresAtIso(config.signedUrlTtlSeconds);
    const updated = await repository.transaction(async (tx) => tx.updateAsset(asset.tenantId, asset.id, { url, urlExpiresAt }));
    return updated ?? { ...asset, url, urlExpiresAt };
  };

  const get = async (id: string, context: RequestContext): Promise<MediaAsset> => {
    const tenantId = requireTenant(context);
    const asset = await repository.transaction(async (tx) => tx.getAsset(tenantId, id));
    if (asset === undefined) {
      // Never distinguish "missing" from "belongs to another tenant".
      throw new GatewayError('ACCESS_DENIED', 'The requested asset is not available for this tenant.');
    }
    return resignIfManaged(asset);
  };

  const upload = async (input: MediaInput, context: RequestContext): Promise<MediaAsset> => {
    requireTenant(context);
    const media = await ingest(input.source, input.mediaType, input.signal, context);
    return publish(media, context, input.signal);
  };

  const resolve = async (reference: MediaReference, context: RequestContext): Promise<MediaAsset> => {
    requireTenant(context);
    if (reference.type === 'asset') return get(reference.assetId, context);
    const media = await ingest(assertReferenceSource(reference), undefined, undefined, context);
    return publish(media, context, undefined);
  };

  const identify = async (reference: MediaReference, context: RequestContext): Promise<MediaIdentity> => {
    const tenantId = requireTenant(context);

    if (reference.type === 'asset') {
      const asset = await repository.transaction(async (tx) => tx.getAsset(tenantId, reference.assetId));
      if (asset === undefined) {
        throw new GatewayError('ACCESS_DENIED', 'The requested asset is not available for this tenant.');
      }
      const identity: MediaIdentity = { kind: 'asset', id: asset.id, mediaType: asset.mediaType, mimeType: asset.mimeType };
      if (asset.size !== undefined) identity.size = asset.size;
      return identity;
    }

    if (reference.type === 'url') {
      // Syntax checks only: `identify` never resolves DNS and never downloads.
      const parsed = assertRemoteUrlSyntax(reference.url);
      return { kind: 'url', id: parsed.toString(), mediaType: mediaTypeFromExtension(parsed.pathname) };
    }

    const source = assertReferenceSource(reference);
    if (!('path' in source)) {
      throw new GatewayError('INVALID_INPUT', 'Unsupported media reference.');
    }
    const meta = await files.identify(source.path);
    return { kind: 'file', id: `sha256:${meta.digest}`, mediaType: meta.mediaType, size: meta.size, mimeType: meta.mimeType };
  };

  return { upload, get, resolve, identify };
}
