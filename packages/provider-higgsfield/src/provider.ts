/**
 * `HiggsfieldProvider` — the SPEC §9 provider port for the Higgsfield public API.
 *
 * Lifecycle rules implemented here (all from the official docs, see
 * `/tmp/hf-research/higgsfield-api-reference.md` for the verbatim citations):
 *
 * - `prepare()` is pure: it applies the documented per-model defaults from the
 *   provider's own JSON Schema, appends the documented `hf_webhook` *query*
 *   parameter, hashes the exact body it froze, and touches no network. The
 *   gateway persists that plan before the first POST.
 * - `submit()` posts `plan.body` verbatim with the stored idempotency key; it
 *   never recomputes, normalizes or redirects.
 * - Job ids handed back to `getJob`/`cancelJob` are opaque adapter handles
 *   (`generation:<request_id>`, `custom_reference:<id>`). Provider-supplied
 *   `status_url`/`cancel_url` values are ignored: the adapter reconstructs the
 *   documented path itself.
 * - Soul ID training (`POST /v1/custom-references`) has a different lifecycle: no
 *   `/requests` polling, no cancellation, and no documented idempotency support.
 */
import { GatewayError, canonicalJson, sha256Hex } from '@higgsfield-mcp/core';
import type {
  CancellationOutcome,
  CostEstimate,
  CredentialResolver,
  GenerationRequest,
  JobKind,
  MediaProvider,
  ModelDefinition,
  ProviderAssetRef,
  ProviderCredentials,
  ProviderFactory,
  ProviderGenerationRequest,
  ProviderJobSnapshot,
  ProviderMediaUpload,
  ProviderSubmissionOptions,
  ProviderSubmissionPlan,
  ProviderUploadInput,
  RequestContext
} from '@higgsfield-mcp/core';
import { z } from 'zod';
import { HiggsfieldHttpClient } from './client/http.js';
import type { HiggsfieldFetch } from './client/http.js';
import { ProviderHttpError } from './errors.js';
import {
  mapCustomReferenceStatus,
  mapProviderStatus,
  parseUsdToMicroUsd,
  toProviderFailure
} from './mapping.js';
import {
  getDocumentedDefaults,
  getModelDefinition,
  getUploadContentTypes,
  getUploadUrlTtlSeconds,
  loadBundledCatalog
} from './models/catalog.js';
import { cloneJsonValue, isRecord, validateAgainstJsonSchema } from './models/validate.js';
import {
  assertSafePathSegment,
  encodeEndpointId,
  encodePathSegment,
  isSafePathSegment,
  isUsableHttpUrl
} from './paths.js';
import { HIGGSFIELD_ADAPTER_VERSION, HIGGSFIELD_PROVIDER_ID } from './version.js';

/** Handle prefix for Model API generation jobs. */
export const GENERATION_HANDLE_PREFIX = 'generation:';
/** Handle prefix for Soul ID custom-reference training jobs. */
export const CUSTOM_REFERENCE_HANDLE_PREFIX = 'custom_reference:';

const MAX_WEBHOOK_URL_LENGTH = 2048;
const MAX_METADATA_STATUS_LENGTH = 64;

export interface ProviderJobHandle {
  kind: JobKind;
  id: string;
}

/**
 * Parses an opaque adapter handle. Anything else — a bare id, a path, a URL, a
 * traversal payload — is rejected with `INVALID_INPUT` before any request is
 * built.
 */
export function parseProviderJobHandle(handle: string): ProviderJobHandle {
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > 300) {
    throw new GatewayError('INVALID_INPUT', 'Provider job id is malformed.');
  }
  if (handle.startsWith(GENERATION_HANDLE_PREFIX)) {
    return {
      kind: 'generation',
      id: assertSafePathSegment(handle.slice(GENERATION_HANDLE_PREFIX.length), 'provider request id')
    };
  }
  if (handle.startsWith(CUSTOM_REFERENCE_HANDLE_PREFIX)) {
    return {
      kind: 'custom_reference',
      id: assertSafePathSegment(handle.slice(CUSTOM_REFERENCE_HANDLE_PREFIX.length), 'custom reference id')
    };
  }
  throw new GatewayError('INVALID_INPUT', 'Provider job id is not a recognised Higgsfield handle.');
}

/**
 * Normalizes caller input into the exact flat body the provider documents:
 * caller values, then documented defaults for absent keys, then validation
 * against the endpoint's own JSON Schema. Deterministic for identical input.
 */
export function buildModelRequestBody(model: ModelDefinition, input: Record<string, unknown>): Record<string, unknown> {
  const cloned = cloneJsonValue(input);
  if (!isRecord(cloned)) {
    throw new GatewayError('INVALID_INPUT', 'Provider input must be a JSON object.');
  }
  const body = cloned;
  for (const [key, value] of Object.entries(getDocumentedDefaults(model.id))) {
    if (!Object.hasOwn(body, key)) body[key] = cloneJsonValue(value);
  }
  const schema = model.inputSchema;
  if (schema === undefined) {
    throw new GatewayError('INTERNAL_ERROR', `The catalog entry ${model.id} has no input schema.`);
  }
  const issues = validateAgainstJsonSchema(schema, body);
  if (issues.length > 0) {
    const first = issues[0];
    throw new GatewayError(
      'INVALID_INPUT',
      `Request parameters do not match the documented schema for ${model.id} (${
        first === undefined ? 'validation failed' : `${first.pointer === '' ? '/' : first.pointer} ${first.message}`
      }).`,
      { details: { issues: issues.slice(0, 10).map((issue) => ({ ...issue })) } }
    );
  }
  return body;
}

/** An id from a provider response is untrusted input: a bad one is a provider fault, not a caller fault. */
function providerIssuedId(value: unknown, label: string): string {
  try {
    return assertSafePathSegment(value, label);
  } catch (error) {
    throw new GatewayError('PROVIDER_ERROR', `The provider returned an unusable ${label}.`, { cause: error });
  }
}

const mediaOutputSchema = z.looseObject({ url: z.string().min(1) });

const requestStatusSchema = z.looseObject({
  status: z.string().min(1),
  request_id: z.string().min(1).optional(),
  error: z.string().nullish(),
  images: z.array(z.unknown()).nullish(),
  video: z.unknown().nullish(),
  audio: z.unknown().nullish(),
  audios: z.array(z.unknown()).nullish()
});

const customReferenceSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1).optional(),
  name: z.string().nullish(),
  model_version: z.string().nullish(),
  thumbnail_url: z.string().nullish(),
  fail_reason: z.string().nullish()
});

const generationSubmissionSchema = z.looseObject({
  status: z.string().optional(),
  request_id: z.string().min(1)
});

const estimateSchema = z.looseObject({
  credits: z.string().optional(),
  usd: z.union([z.string(), z.number()])
});

const uploadTicketSchema = z.looseObject({
  public_url: z.string().min(1),
  upload_url: z.string().min(1),
  content_type: z.string().min(1),
  upload_headers: z.record(z.string(), z.string())
});

type RequestStatusPayload = z.infer<typeof requestStatusSchema>;

function mediaUrl(entry: unknown): string | undefined {
  const parsed = mediaOutputSchema.safeParse(entry);
  if (!parsed.success) return undefined;
  return isUsableHttpUrl(parsed.data.url) ? parsed.data.url : undefined;
}

/** Flattens the documented image/video/audio output fields into asset references, de-duplicated by URL. */
function collectRequestAssets(status: RequestStatusPayload): ProviderAssetRef[] {
  const assets: ProviderAssetRef[] = [];
  const seen = new Set<string>();
  const push = (url: string | undefined, mediaType: ProviderAssetRef['mediaType']): void => {
    if (url === undefined || seen.has(url)) return;
    seen.add(url);
    assets.push({ url, mediaType });
  };
  for (const image of status.images ?? []) push(mediaUrl(image), 'image');
  push(mediaUrl(status.video), 'video');
  push(mediaUrl(status.audio), 'audio');
  for (const audio of status.audios ?? []) push(mediaUrl(audio), 'audio');
  return assets;
}

function providerStatusMetadata(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  return { provider_status: raw.slice(0, MAX_METADATA_STATUS_LENGTH) };
}

/** Snapshot for a freshly accepted Model API submission. */
export function toGenerationSubmissionSnapshot(json: unknown): ProviderJobSnapshot {
  const parsed = generationSubmissionSchema.safeParse(json);
  if (!parsed.success) {
    throw new GatewayError('PROVIDER_ERROR', 'The provider returned an unusable generation submission response.');
  }
  const requestId = providerIssuedId(parsed.data.request_id, 'request id');
  return {
    providerJobId: `${GENERATION_HANDLE_PREFIX}${requestId}`,
    // Docs: a replay is an acceptance receipt and may report `queued` even for a
    // finished request; the authoritative state always comes from the status path.
    status: 'queued',
    assets: [],
    metadata: providerStatusMetadata(parsed.data.status)
  };
}

/** Snapshot for a `GET /requests/{id}/status` response. */
export function toGenerationStatusSnapshot(json: unknown, handleId: string): ProviderJobSnapshot {
  const parsed = requestStatusSchema.safeParse(json);
  if (!parsed.success) {
    throw new GatewayError('PROVIDER_ERROR', 'The provider returned an unusable request status response.');
  }
  const raw = parsed.data.status;
  const mapped = mapProviderStatus(raw);
  const error = toProviderFailure({ status: raw, error: parsed.data.error });
  const metadata: Record<string, unknown> = { ...providerStatusMetadata(raw) };
  const customReferenceId = parsed.data['custom_reference_id'];
  if (typeof customReferenceId === 'string' && isSafePathSegment(customReferenceId)) {
    metadata['custom_reference_id'] = customReferenceId;
  }
  return {
    providerJobId: `${GENERATION_HANDLE_PREFIX}${handleId}`,
    status: mapped.status,
    assets: collectRequestAssets(parsed.data),
    ...(error === undefined ? {} : { error }),
    metadata
  };
}

/** Snapshot for a Soul ID custom reference, from either the POST or the GET. */
export function toCustomReferenceSnapshot(json: unknown, handleId?: string): ProviderJobSnapshot {
  const parsed = customReferenceSchema.safeParse(json);
  if (!parsed.success) {
    throw new GatewayError('PROVIDER_ERROR', 'The provider returned an unusable custom reference response.');
  }
  const id = providerIssuedId(parsed.data.id, 'custom reference id');
  const raw = parsed.data.status;
  const mapped = raw === undefined ? { status: 'queued' as const, known: true, raw: 'not_ready' } : mapCustomReferenceStatus(raw);
  const assets: ProviderAssetRef[] = [];
  const thumbnail = parsed.data.thumbnail_url;
  if (mapped.status === 'completed' && isUsableHttpUrl(thumbnail)) assets.push({ url: thumbnail, mediaType: 'image' });
  const error = toProviderFailure({ status: raw, failReason: parsed.data.fail_reason });
  const modelVersion = parsed.data.model_version;
  return {
    providerJobId: `${CUSTOM_REFERENCE_HANDLE_PREFIX}${handleId ?? id}`,
    status: mapped.status,
    assets,
    ...(error === undefined ? {} : { error }),
    metadata: {
      custom_reference_id: id,
      ...providerStatusMetadata(raw === undefined ? mapped.raw : raw),
      ...(typeof modelVersion === 'string' && modelVersion.length > 0 && modelVersion.length <= 32
        ? { model_version: modelVersion }
        : {})
    }
  };
}

export interface HiggsfieldProviderOptions {
  /** Resolved credential binding; the adapter never reads credentials from the environment. */
  credentials: ProviderCredentials;
  baseUrl?: string | undefined;
  requestTimeoutMs?: number | undefined;
  uploadTimeoutMs?: number | undefined;
  /** Injection point for contract-test doubles; defaults to the global `fetch`. */
  fetchImpl?: HiggsfieldFetch | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  maxResponseBytes?: number | undefined;
}

export class HiggsfieldProvider implements MediaProvider {
  readonly id = HIGGSFIELD_PROVIDER_ID;
  readonly version = HIGGSFIELD_ADAPTER_VERSION;
  /** Stable upstream account binding for provider-side concurrency accounting. */
  readonly accountId: string;

  private readonly http: HiggsfieldHttpClient;

  constructor(options: HiggsfieldProviderOptions) {
    const accountId = options.credentials.accountId;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new GatewayError('AUTHENTICATION_FAILED', 'The resolved provider credential has no account binding.');
    }
    this.accountId = accountId;
    this.http = new HiggsfieldHttpClient({
      credentials: options.credentials,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.uploadTimeoutMs === undefined ? {} : { uploadTimeoutMs: options.uploadTimeoutMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.defaultHeaders === undefined ? {} : { defaultHeaders: options.defaultHeaders }),
      ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes })
    });
  }

  /** Pure and deterministic: same request in, byte-identical plan out. */
  prepare(request: ProviderGenerationRequest): ProviderSubmissionPlan {
    const model = getModelDefinition(request.endpoint);
    if (model.kind !== request.jobKind) {
      throw new GatewayError('INVALID_INPUT', 'The requested job kind does not match the resolved model lifecycle.', {
        details: { modelKind: model.kind, jobKind: request.jobKind }
      });
    }
    const body = buildModelRequestBody(model, request.input);
    const plan: ProviderSubmissionPlan = {
      endpoint: model.endpoint,
      body,
      bodyHash: sha256Hex(canonicalJson(body)),
      jobKind: model.kind
    };
    const webhookUrl = request.webhook?.url;
    if (webhookUrl === undefined) return plan;
    if (webhookUrl.length > MAX_WEBHOOK_URL_LENGTH) {
      throw new GatewayError('INVALID_INPUT', 'The webhook URL is too long.');
    }
    let parsedWebhook: URL;
    try {
      parsedWebhook = new URL(webhookUrl);
    } catch {
      throw new GatewayError('INVALID_INPUT', 'The webhook URL is not an absolute URL.');
    }
    // Docs: "Pass an HTTPS endpoint in the hf_webhook query parameter".
    if (parsedWebhook.protocol !== 'https:') {
      throw new GatewayError('INVALID_INPUT', 'The webhook URL must use https.');
    }
    return { ...plan, query: { hf_webhook: webhookUrl }, webhook: { url: webhookUrl } };
  }

  async submit(plan: ProviderSubmissionPlan, options: ProviderSubmissionOptions): Promise<ProviderJobSnapshot> {
    if (typeof plan.bodyHash !== 'string' || !/^[0-9a-f]{64}$/.test(plan.bodyHash)) {
      throw new GatewayError('INVALID_INPUT', 'The persisted provider submission plan is malformed.');
    }
    const path = `/${encodeEndpointId(plan.endpoint)}`;
    const isCustomReference = plan.jobKind === 'custom_reference';
    const response = await this.http.post(path, plan.body, {
      // Idempotency keys are documented for Model API generation submissions only.
      ...(isCustomReference ? {} : { idempotencyKey: options.upstreamIdempotencyKey }),
      ...(plan.query === undefined ? {} : { query: plan.query }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    return isCustomReference ? toCustomReferenceSnapshot(response.json) : toGenerationSubmissionSnapshot(response.json);
  }

  async generate(request: ProviderGenerationRequest): Promise<ProviderJobSnapshot> {
    return this.submit(this.prepare(request), {
      upstreamIdempotencyKey: request.upstreamIdempotencyKey,
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
  }

  async getJob(id: string): Promise<ProviderJobSnapshot> {
    const handle = parseProviderJobHandle(id);
    if (handle.kind === 'generation') {
      const path = `/requests/${encodePathSegment(handle.id, 'provider request id')}/status`;
      const response = await this.http.get(path);
      return toGenerationStatusSnapshot(response.json, handle.id);
    }
    const path = `/v1/custom-references/${encodePathSegment(handle.id, 'custom reference id')}`;
    const response = await this.http.get(path);
    return toCustomReferenceSnapshot(response.json, handle.id);
  }

  async cancelJob(id: string): Promise<CancellationOutcome> {
    const handle = parseProviderJobHandle(id);
    if (handle.kind === 'custom_reference') {
      // Docs document no cancellation for custom references.
      return { accepted: false, reason: 'unsupported' };
    }
    const path = `/requests/${encodePathSegment(handle.id, 'provider request id')}/cancel`;
    try {
      const response = await this.http.post(path, undefined);
      if (response.status === 202 || response.status === 200) return { accepted: true };
      return { accepted: false, reason: 'processing_started' };
    } catch (error) {
      if (error instanceof ProviderHttpError && error.operation === 'cancel') {
        if (error.status === 400) {
          // Documented: 400 means the request already started and is terminal.
          const snapshot = await this.tryGetJob(id);
          return snapshot === undefined
            ? { accepted: false, reason: 'processing_started' }
            : { accepted: false, reason: 'processing_started', snapshot };
        }
        if (error.status === 404) return { accepted: false, reason: 'not_found' };
      }
      throw error;
    }
  }

  async uploadMedia(input: ProviderUploadInput): Promise<ProviderMediaUpload> {
    const supported = getUploadContentTypes();
    if (!supported.includes(input.mimeType)) {
      throw new GatewayError('INVALID_INPUT', 'Unsupported content type for Higgsfield uploads.', {
        details: { supportedContentTypes: supported }
      });
    }
    const created = await this.http.post('/files/generate-upload-url', { content_type: input.mimeType }, {
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const ticket = uploadTicketSchema.safeParse(created.json);
    if (!ticket.success) {
      throw new GatewayError('MEDIA_UPLOAD_FAILED', 'The provider returned an unusable upload ticket.');
    }
    if (!supported.includes(ticket.data.content_type)) {
      throw new GatewayError('MEDIA_UPLOAD_FAILED', 'The provider upload ticket returned an unsupported content type.');
    }
    // The ticket's content type is authoritative: it is the value the presigned
    // URL was created for (and it is what the returned upload headers carry).
    const uploadedContentType = ticket.data.content_type;
    // Docs: "Send the file to upload_url with every header returned in
    // upload_headers" and never the Higgsfield API credentials.
    await this.http.put(ticket.data.upload_url, input.bytes, ticket.data.upload_headers, {
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return {
      url: ticket.data.public_url,
      provider: HIGGSFIELD_PROVIDER_ID,
      mediaType: input.mediaType,
      mimeType: uploadedContentType,
      size: input.bytes.byteLength,
      // Documented: "The upload URL expires after one hour."
      expiresAt: new Date(Date.now() + getUploadUrlTtlSeconds() * 1000).toISOString()
    };
  }

  async getModels(): Promise<ModelDefinition[]> {
    return loadBundledCatalog();
  }

  async getModel(id: string): Promise<ModelDefinition> {
    return getModelDefinition(id);
  }

  async estimateCost(request: GenerationRequest): Promise<CostEstimate> {
    const model = getModelDefinition(request.endpoint);
    if (model.kind === 'custom_reference') {
      // `/estimate/{endpoint_id}` is documented only for Model API endpoints.
      throw new GatewayError('INVALID_INPUT', 'Cost estimation is not documented for this endpoint.');
    }
    const body = buildModelRequestBody(model, request.input);
    const response = await this.http.post(`/estimate/${encodeEndpointId(model.endpoint)}`, body);
    const parsed = estimateSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new GatewayError('PROVIDER_ERROR', 'The provider returned an unusable cost estimate response.');
    }
    return {
      microUsd: parseUsdToMicroUsd(parsed.data.usd),
      currency: 'USD',
      source: 'estimate_api',
      endpoint: model.endpoint,
      estimatedAt: new Date().toISOString()
    };
  }

  /**
   * The provider documents submission idempotency for Model API generation
   * (`Idempotency-Key`, 1–255 visible ASCII characters). Soul ID training is not
   * documented as covered, so it is reported as `unknown`.
   */
  getIdempotencySupport(kind: JobKind = 'generation'): 'documented' | 'unknown' {
    return kind === 'generation' ? 'documented' : 'unknown';
  }

  private async tryGetJob(id: string): Promise<ProviderJobSnapshot | undefined> {
    try {
      return await this.getJob(id);
    } catch {
      return undefined;
    }
  }
}

export interface HiggsfieldProviderFactoryOptions {
  /** Resolves the tenant/user binding to an upstream credential at call time. */
  credentialResolver: CredentialResolver;
  baseUrl?: string | undefined;
  requestTimeoutMs?: number | undefined;
  uploadTimeoutMs?: number | undefined;
  fetchImpl?: HiggsfieldFetch | undefined;
  maxResponseBytes?: number | undefined;
}

/**
 * Builds a `ProviderFactory`. A fresh provider (and therefore a fresh credential
 * binding) is created per request context; nothing is cached across tenants.
 */
export function createHiggsfieldProviderFactory(options: HiggsfieldProviderFactoryOptions): ProviderFactory {
  const { credentialResolver, baseUrl, requestTimeoutMs, uploadTimeoutMs, fetchImpl, maxResponseBytes } = options;
  return {
    providerId: HIGGSFIELD_PROVIDER_ID,
    async forContext(context: RequestContext): Promise<MediaProvider> {
      const credentials = await credentialResolver.resolve(context);
      return new HiggsfieldProvider({
        credentials,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(uploadTimeoutMs === undefined ? {} : { uploadTimeoutMs }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes })
      });
    }
  };
}
