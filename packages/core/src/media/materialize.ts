import { createAssetFromProviderRef } from '../capabilities/assets.js';
import type { Clock, GenerationJob, LoggerPort, MediaAsset, MetricsPort, ObjectStore, ProviderAssetRef } from '../contracts.js';
import { GatewayError } from '../errors.js';
import { safeUrlForLogging } from '../redact.js';
import { createRemoteFetcher } from './remote-fetch.js';
import { managedObjectKey } from './service.js';

/** Mirrors `SubmissionWorkerOptions.materializeAssets`. */
export type ProviderAssetMaterializer = (refs: ProviderAssetRef[], job: GenerationJob) => Promise<MediaAsset[]>;

export interface ProviderAssetMaterializerOptions {
  assetMode: 'passthrough' | 'managed';
  maxUploadBytes: number;
  downloadTimeoutMs: number;
  maxRedirects: number;
  signedUrlTtlSeconds: number;
  clock: Clock;
  logger: LoggerPort;
  objectStore?: ObjectStore | undefined;
  metrics?: MetricsPort | undefined;
  fetchImpl?: typeof fetch | undefined;
  resolveHost?: ((hostname: string) => Promise<string[]>) | undefined;
}

/**
 * Turns provider result references into asset rows, downloading the bytes into
 * managed storage when that mode is on. This is the only sanctioned path for
 * fetching provider-returned asset URLs: it runs the same SSRF checks, size
 * caps, and MIME validation as caller URLs.
 *
 * A copy failure raises `MEDIA_UPLOAD_FAILED` and never re-submits to the
 * provider; the caller records the asset state and retries the copy.
 */
export function createProviderAssetMaterializer(options: ProviderAssetMaterializerOptions): ProviderAssetMaterializer {
  const objectStore = options.objectStore;
  if (options.assetMode === 'managed' && objectStore === undefined) {
    throw new GatewayError('INTERNAL_ERROR', 'Managed asset mode requires an object store.');
  }
  const logger = options.logger.child({ component: 'media' });
  const remote = createRemoteFetcher({
    maxBytes: options.maxUploadBytes,
    downloadTimeoutMs: options.downloadTimeoutMs,
    maxRedirects: options.maxRedirects,
    logger,
    mimePolicy: 'result',
    fetchImpl: options.fetchImpl,
    resolveHost: options.resolveHost
  });

  return async (refs: ProviderAssetRef[], job: GenerationJob): Promise<MediaAsset[]> => {
    const createdAt = options.clock.now().toISOString();
    const assets: MediaAsset[] = [];

    for (const ref of refs) {
      const asset = createAssetFromProviderRef(ref, {
        tenantId: job.tenantId,
        provider: job.provider,
        jobId: job.id,
        createdAt,
        ...(job.workspaceId === undefined ? {} : { workspaceId: job.workspaceId })
      });

      if (options.assetMode === 'passthrough') {
        assets.push(asset);
        continue;
      }
      if (objectStore === undefined) {
        throw new GatewayError('INTERNAL_ERROR', 'Managed asset mode requires an object store.');
      }

      const media = await remote.fetchMedia(ref.url);
      options.metrics?.mediaUploadBytes('in', media.bytes.byteLength);

      const key = managedObjectKey(job.tenantId, asset.id);
      try {
        await objectStore.put(key, media.bytes, media.mimeType);
      } catch (error) {
        logger.warn({ jobId: job.id, assetId: asset.id, url: safeUrlForLogging(ref.url) }, 'Copying a provider asset failed.');
        throw new GatewayError('MEDIA_UPLOAD_FAILED', 'Copying the provider asset into managed storage failed.', { cause: error });
      }

      let url: string;
      try {
        url = await objectStore.signedGetUrl(key, options.signedUrlTtlSeconds);
      } catch (error) {
        throw new GatewayError('INTERNAL_ERROR', 'Signing a managed asset URL failed.', { cause: error });
      }

      asset.storageKey = key;
      asset.url = url;
      asset.urlExpiresAt = new Date(options.clock.now().getTime() + options.signedUrlTtlSeconds * 1000).toISOString();
      if (asset.mediaType !== media.mediaType || asset.mimeType !== media.mimeType) {
        // The downloaded bytes are authoritative; a provider that mislabels a
        // result must not be able to mislead downstream model selection.
        logger.warn(
          { jobId: job.id, assetId: asset.id, declared: asset.mimeType, detected: media.mimeType },
          'Provider asset type did not match the downloaded content; using the detected type.'
        );
        asset.mediaType = media.mediaType;
        asset.mimeType = media.mimeType;
      }
      if (ref.size === undefined) asset.size = media.bytes.byteLength;
      assets.push(asset);
    }

    return assets;
  };
}
