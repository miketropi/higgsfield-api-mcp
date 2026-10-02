/**
 * Frozen cross-package domain contract.
 *
 * Every package in this repository depends on these types. They are owned by the
 * integration lead: a change here is an architectural change and must not be made
 * unilaterally by a worker.
 *
 * Conventions
 * - Internal models are camelCase. Snake_case exists only at the MCP wire boundary
 *   (`@higgsfield-mcp/mcp/schemas`).
 * - Money is carried as integer micro-USD everywhere inside the gateway. Decimal
 *   strings from provider APIs are parsed at the adapter boundary.
 * - No credential material is ever placed on a job, asset, or log record.
 */

/** Public job status union (SPEC §11). */
export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Canonical error codes (SPEC §32). */
export const ERROR_CODES = [
  'AUTHENTICATION_FAILED',
  'ACCESS_DENIED',
  'INSUFFICIENT_CREDITS',
  'INVALID_INPUT',
  'MODEL_NOT_FOUND',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'MEDIA_UPLOAD_FAILED',
  'JOB_NOT_FOUND',
  'JOB_FAILED',
  'TIMEOUT',
  'CANCELLED',
  'COST_LIMIT_EXCEEDED',
  'POLICY_REJECTED',
  'PROVIDER_ERROR',
  'INTERNAL_ERROR'
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface StructuredError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
  details?: Record<string, unknown> | undefined;
}

/**
 * Internal provider submission state. Persisted, never public. A job whose
 * submission is unresolved keeps a non-terminal public `JobStatus`.
 *
 * - `pending`: admitted, not yet POSTed to the provider.
 * - `submitting`: a POST is in flight or an ambiguous attempt is being retried.
 * - `acknowledged`: the provider accepted the request and returned an id.
 * - `outcome_unknown`: an ambiguous POST happened on an endpoint with no documented
 *   idempotency guarantee; never replayed automatically.
 * - `rejected`: the provider definitively refused the request before acceptance
 *   (auth/validation/credit refusal), so the key was not consumed and no retry is safe.
 * - `cancelled`: cancelled by the caller before any provider POST happened.
 */
export const SUBMISSION_STATES = [
  'pending',
  'submitting',
  'acknowledged',
  'outcome_unknown',
  'rejected',
  'cancelled'
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** Provider lifecycle family selected by the adapter. */
export type JobKind = 'generation' | 'custom_reference';

/** Concurrency bucket used for provider-side slot accounting (SPEC §39, §66). */
export type ConcurrencyClass = 'image' | 'video' | 'other';

export type MediaType = 'image' | 'video' | 'audio' | '3d';

export type MediaReference =
  | { type: 'url'; url: string }
  | { type: 'asset'; assetId: string }
  | { type: 'file'; path: string };

export type CostSource = 'estimate_api' | 'operator_override' | 'unavailable';

export interface CostInfo {
  currency: 'USD';
  estimatedMicroUsd?: number | undefined;
  actualMicroUsd?: number | undefined;
  source: CostSource;
  estimatedAt?: string | undefined;
  note?: string | undefined;
}

export type AssetOrigin = 'provider' | 'upload' | 'managed';

export interface MediaAsset {
  id: string;
  tenantId: string;
  provider: string;
  mediaType: MediaType;
  mimeType: string;
  /** Absent when the provider does not report a size. */
  size?: number | undefined;
  url: string;
  createdAt: string;
  width?: number | undefined;
  height?: number | undefined;
  durationSeconds?: number | undefined;
  origin: AssetOrigin;
  storageKey?: string | undefined;
  /** ISO timestamp after which `url` stops working (short-lived signed URLs). */
  urlExpiresAt?: string | undefined;
  workspaceId?: string | undefined;
  sha256?: string | undefined;
}

export interface GenerationJob {
  id: string;
  tenantId: string;
  workspaceId?: string | undefined;
  provider: string;
  providerJobId?: string | undefined;
  capability: string;
  model?: string | undefined;
  endpoint?: string | undefined;
  kind: JobKind;
  status: JobStatus;
  progress?: number | undefined;
  createdAt: string;
  updatedAt: string;
  /** Provider-request-safe summary. Never contains raw prompts or media bytes. */
  inputSummary: Record<string, unknown>;
  assets: MediaAsset[];
  cost?: CostInfo | undefined;
  error?: StructuredError | undefined;
  /** Sanitized public job metadata. */
  metadata?: Record<string, unknown> | undefined;
  submissionState: SubmissionState;
  tool: string;
  concurrencyClass: ConcurrencyClass;
}

export interface AuthContext {
  tenantId: string;
  mode: 'stdio' | 'static_token' | 'oauth_jwt';
  scopes: string[];
  tokenId?: string | undefined;
  subject?: string | undefined;
  expiresAt?: string | undefined;
  /** Opaque SDK AuthInfo passthrough; never serialized into responses. */
  authInfo?: unknown;
}

export interface TraceContext {
  traceId: string;
  spanId?: string | undefined;
}

export interface RequestContext {
  requestId: string;
  tenantId?: string | undefined;
  workspaceId?: string | undefined;
  transport: 'stdio' | 'http';
  auth?: AuthContext | undefined;
  trace?: TraceContext | undefined;
}

export const SCOPES = {
  read: 'higgsfield:read',
  generate: 'higgsfield:generate',
  upload: 'higgsfield:upload'
} as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** Client-supplied generation intent. */
export interface GenerationRequest {
  endpoint: string;
  input: Record<string, unknown>;
  idempotencyKey?: string | undefined;
  workspaceId?: string | undefined;
  wait?: boolean | undefined;
  confirmationToken?: string | undefined;
  webhook?: { url: string } | undefined;
  signal?: AbortSignal | undefined;
}

/** Adapter-facing generation request. */
export interface ProviderGenerationRequest extends GenerationRequest {
  /**
   * Gateway-generated, persisted upstream idempotency key. Immutable for the
   * lifetime of the job's submission envelope.
   */
  upstreamIdempotencyKey: string;
  jobKind: JobKind;
}

export interface MediaInput {
  source: { path: string } | { url: string };
  mediaType?: MediaType | undefined;
  signal?: AbortSignal | undefined;
}

/** Bytes already validated by `MediaService`; adapters never fetch caller URLs. */
export interface ProviderUploadInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  mediaType: MediaType;
  signal?: AbortSignal | undefined;
}

export interface ProviderMediaUpload {
  /** Provider-visible URL usable as a generation input. */
  url: string;
  provider: string;
  mediaType: MediaType;
  mimeType: string;
  size: number;
  expiresAt?: string | undefined;
}

export interface ProviderAssetRef {
  url: string;
  mediaType: MediaType;
  mimeType?: string | undefined;
  size?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  durationSeconds?: number | undefined;
}

export type CancellationOutcome =
  | { accepted: true; snapshot?: ProviderJobSnapshot | undefined }
  | {
      accepted: false;
      reason: 'processing_started' | 'unsupported' | 'not_found';
      snapshot?: ProviderJobSnapshot | undefined;
    };

/** Normalized provider view. The gateway alone mints authoritative ids/timestamps. */
export interface ProviderJobSnapshot {
  providerJobId: string;
  status: JobStatus;
  progress?: number | undefined;
  assets: ProviderAssetRef[];
  error?: StructuredError | undefined;
  cost?: CostInfo | undefined;
  /** Provider-native metadata safe to expose (e.g. custom_reference_id). */
  metadata?: Record<string, unknown> | undefined;
}

export interface ProviderCredentials {
  /** Pre-encoded credential string accepted by the provider `Authorization` header. */
  credentials: string;
  /**
   * Operator-stable upstream account binding. Shares a value across key rotations
   * and across tenants using the same upstream account.
   */
  accountId: string;
}

export interface CostEstimate {
  microUsd: number;
  currency: 'USD';
  source: Exclude<CostSource, 'unavailable'>;
  endpoint: string;
  estimatedAt: string;
}

/** Provider port. Implemented by `@higgsfield-mcp/provider-higgsfield` (SPEC §9). */
export interface MediaProvider {
  readonly id: string;
  readonly version: string;
  /** Stable upstream account binding from the resolved credentials. */
  readonly accountId: string;
  /**
   * Pure: applies documented defaults and returns the exact JSON body that must be
   * persisted before the first POST. Deterministic for identical requests.
   */
  prepare(request: ProviderGenerationRequest): ProviderSubmissionPlan;
  /** POSTs `plan.body` verbatim. Never recomputes, normalizes, or redirects. */
  submit(plan: ProviderSubmissionPlan, options: ProviderSubmissionOptions): Promise<ProviderJobSnapshot>;
  /** `submit(prepare(request), { upstreamIdempotencyKey })` convenience (SPEC §9). */
  generate(request: ProviderGenerationRequest): Promise<ProviderJobSnapshot>;
  getJob(id: string): Promise<ProviderJobSnapshot>;
  cancelJob(id: string): Promise<CancellationOutcome>;
  uploadMedia(input: ProviderUploadInput): Promise<ProviderMediaUpload>;
  getModels(): Promise<ModelDefinition[]>;
  getModel(id: string): Promise<ModelDefinition>;
  estimateCost?(request: GenerationRequest): Promise<CostEstimate>;
  /**
   * `documented` only where the provider publishes a submission idempotency
   * guarantee for THAT lifecycle; `unknown` (or absent) means an ambiguous
   * submission is never replayed automatically. The kind matters: Model API
   * generation submissions are covered by the documented guarantee while Soul
   * training (`custom_reference`) is not, so it must never be replayed blindly.
   */
  getIdempotencySupport?(kind: JobKind): 'documented' | 'unknown';
}

export interface ProviderSubmissionPlan {
  endpoint: string;
  /** Exact JSON body, immutable once persisted. */
  body: Record<string, unknown>;
  /** sha256 hex of `canonicalJson(body)`. */
  bodyHash: string;
  /**
   * Exact query parameters (e.g. the documented `hf_webhook` parameter), frozen
   * with the body. Serialized in sorted-key order.
   */
  query?: Record<string, string> | undefined;
  webhook?: { url: string } | undefined;
  jobKind: JobKind;
}

export interface ProviderSubmissionOptions {
  upstreamIdempotencyKey: string;
  signal?: AbortSignal | undefined;
}

/** Instantiated per resolved credential binding; never a mutable global. */
export interface ProviderFactory {
  readonly providerId: string;
  forContext(context: RequestContext): Promise<MediaProvider>;
}

export interface CredentialResolver {
  resolve(context: RequestContext): Promise<ProviderCredentials>;
}

export type ModelType = 'image' | 'video' | 'audio' | '3d';
export type ModelStatus = 'active' | 'deprecated' | 'experimental';

export interface PricingDefinition {
  currency: 'USD';
  unitMicroUsd?: number | undefined;
  perSecondMicroUsd?: number | undefined;
  source: string;
  asOf: string;
}

export interface ModelLimits {
  durationsSeconds?: number[] | undefined;
  aspectRatios?: string[] | undefined;
  resolutions?: string[] | undefined;
  maxCount?: number | undefined;
  maxReferenceImages?: number | undefined;
  maxPromptLength?: number | undefined;
  maxUploadBytes?: number | undefined;
  supportedMimeTypes?: string[] | undefined;
}

export interface ModelSource {
  url: string;
  asOf: string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  type: ModelType;
  endpoint: string;
  kind: JobKind;
  concurrencyClass: ConcurrencyClass;
  capabilities: string[];
  status: ModelStatus;
  limits: ModelLimits;
  inputSchema?: Record<string, unknown> | undefined;
  pricing?: PricingDefinition | undefined;
  source: ModelSource;
  /** Capabilities that are mutually exclusive in a single request. */
  exclusiveCapabilities?: string[] | undefined;
}

export interface ModelFilter {
  type?: ModelType | undefined;
  capability?: string | undefined;
}

export interface ModelRegistry {
  list(filter?: ModelFilter): ModelDefinition[];
  get(id: string): ModelDefinition;
  resolve(idOrAlias: string, capability: string): ModelDefinition;
  aliases(): Record<string, string>;
}

export interface ServiceCapabilities {
  provider: string;
  capabilities: string[];
}

export const CAPABILITIES = {
  imageGeneration: 'image_generation',
  imageEdit: 'image_edit',
  textToVideo: 'text_to_video',
  imageToVideo: 'image_to_video',
  referenceToVideo: 'reference_to_video',
  referenceImages: 'reference_images',
  endImage: 'end_image',
  customReferenceTraining: 'custom_reference_training',
  identityGeneration: 'identity_generation',
  audioGeneration: 'audio_generation'
} as const;
export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export interface ConfirmationRequired {
  status: 'confirmation_required';
  estimatedCostUsd: number;
  confirmationToken: string;
  expiresAt: string;
}

export type GenerationResult = GenerationJob | ConfirmationRequired;

export function isConfirmationRequired(result: GenerationResult): result is ConfirmationRequired {
  return (result as ConfirmationRequired).status === 'confirmation_required';
}

export interface JobListResult {
  jobs: GenerationJob[];
  nextCursor?: string | undefined;
  next_cursor?: string | undefined;
}

export interface JobListOptions {
  limit: number;
  cursor?: string | undefined;
  workspaceId?: string | undefined;
}

export interface GenerationService {
  submit(tool: string, request: GenerationRequest, context: RequestContext): Promise<GenerationResult>;
}

export interface JobService {
  get(id: string, context: RequestContext): Promise<GenerationJob>;
  wait(id: string, timeoutMs: number, context: RequestContext): Promise<GenerationJob>;
  cancel(id: string, context: RequestContext): Promise<GenerationJob>;
  list(context: RequestContext, cursor?: string): Promise<JobListResult>;
}

export interface MediaService {
  upload(input: MediaInput, context: RequestContext): Promise<MediaAsset>;
  get(id: string, context: RequestContext): Promise<MediaAsset>;
  resolve(reference: MediaReference, context: RequestContext): Promise<MediaAsset>;
  /**
   * Cheap stable identity for idempotency hashing, computed BEFORE any upload:
   * file → `sha256:<digest of the allowlisted file bytes>`, url → the normalized
   * URL, asset → the asset id. Never performs an upload or a network download.
   */
  identify(reference: MediaReference, context: RequestContext): Promise<MediaIdentity>;
}

export interface MediaIdentity {
  kind: 'file' | 'url' | 'asset';
  id: string;
  mediaType: MediaType;
  size?: number | undefined;
  mimeType?: string | undefined;
}

/**
 * Metrics port (SPEC §43). Implemented by `@higgsfield-mcp/observability`.
 * Labels are bounded enumerations only: never tenant/job/request ids, URLs or prompts.
 */
export interface MetricsPort {
  toolCall(tool: string, transport: 'stdio' | 'http'): void;
  toolError(tool: string, code: string): void;
  jobStarted(provider: string, capability: string, jobKind: string): void;
  jobFinished(provider: string, capability: string, jobKind: string, status: string, durationSeconds: number): void;
  providerRequest(provider: string, endpoint: string, outcome: 'ok' | 'error'): void;
  providerError(provider: string, code: string): void;
  mediaUploadBytes(direction: 'in' | 'out', bytes: number): void;
  estimatedCostUsd(microUsd: number): void;
  activeJobs(concurrencyClass: string, delta: number): void;
  queuedJobs(concurrencyClass: string, delta: number): void;
}

export interface LoggerPort {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): LoggerPort;
}

/** Object storage port for managed assets (S3/R2/MinIO). */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  signedGetUrl(key: string, expiresInSeconds: number): Promise<string>;
  health(): Promise<void>;
}

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitDimension {
  dimension: 'tenant' | 'token' | 'tool' | 'provider' | 'global';
  key: string;
  rule: RateLimitRule;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number | undefined;
  limitedBy?: RateLimitDimension['dimension'] | undefined;
}

/** Redis-backed in remote mode; in-process memory for stdio. */
export interface RateLimiter {
  /** Atomically checks every dimension, then consumes one unit where allowed. */
  check(dimensions: RateLimitDimension[]): Promise<RateLimitDecision>;
  health(): Promise<void>;
  close(): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface AuditEvent {
  tenantId: string;
  at: string;
  event: string;
  jobId?: string | undefined;
  assetId?: string | undefined;
  tokenId?: string | undefined;
  requestId?: string | undefined;
  details?: Record<string, unknown> | undefined;
}
