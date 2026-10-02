import type {
  AuditEvent,
  ConcurrencyClass,
  CostInfo,
  GenerationJob,
  JobKind,
  JobListOptions,
  JobListResult,
  JobStatus,
  MediaAsset,
  StructuredError,
  SubmissionState
} from '../contracts.js';

/**
 * The port re-exports the entity types used in its own signatures so adapters can
 * import everything they need from one module.
 */
export type {
  AuditEvent,
  ConcurrencyClass,
  CostInfo,
  GenerationJob,
  JobKind,
  JobListOptions,
  JobListResult,
  JobStatus,
  MediaAsset,
  StructuredError,
  SubmissionState
} from '../contracts.js';

export interface IdempotencyRecord {
  tenantId: string;
  tool: string;
  key: string;
  /** Hash of the normalized caller intent (no signed URLs, no volatile fields). */
  requestHash: string;
  jobId: string;
  createdAt: string;
}

/**
 * Immutable provider submission envelope. Persisted before the provider POST and
 * replayed byte-identically after an ambiguous failure or a restart.
 */
export interface SubmissionEnvelope {
  jobId: string;
  tenantId: string;
  provider: string;
  providerAccountId: string;
  jobKind: JobKind;
  concurrencyClass: ConcurrencyClass;
  endpoint: string;
  /** Persisted upstream Idempotency-Key header value. */
  upstreamIdempotencyKey: string;
  /** Exact provider request body, frozen before the first POST. */
  body: Record<string, unknown>;
  bodyHash: string;
  /** Exact query parameters, frozen with the body (e.g. the webhook parameter). */
  query?: Record<string, string> | undefined;
  webhookUrl?: string | undefined;
  /** Encrypted at rest; only the hash is indexed. */
  callbackToken?: string | undefined;
  callbackTokenHash?: string | undefined;
  state: SubmissionState;
  attempts: number;
  providerJobId?: string | undefined;
  lastAttemptAt?: string | undefined;
  nextAttemptAt?: string | undefined;
  lastError?: StructuredError | undefined;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionPatch {
  state?: SubmissionState | undefined;
  attempts?: number | undefined;
  providerJobId?: string | undefined;
  lastAttemptAt?: string | undefined;
  nextAttemptAt?: string | undefined;
  lastError?: StructuredError | undefined;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
}

export interface ClaimOptions {
  owner: string;
  leaseTtlMs: number;
  now: string;
  batchLimit: number;
  /** Per-class in-flight ceiling, counted across the whole provider account. */
  maxPerClass: Record<ConcurrencyClass, number>;
}

export interface JobPatch {
  status?: JobStatus | undefined;
  providerJobId?: string | undefined;
  progress?: number | undefined;
  assets?: MediaAsset[] | undefined;
  cost?: CostInfo | undefined;
  error?: StructuredError | undefined;
  metadata?: Record<string, unknown> | undefined;
  inputSummary?: Record<string, unknown> | undefined;
  updatedAt: string;
}

export interface CasOptions {
  expectStatus?: JobStatus[] | undefined;
  expectSubmissionState?: SubmissionState[] | undefined;
}

export interface UsageReservation {
  jobId: string;
  tenantId: string;
  day: string;
  microUsd: number;
  providerAccountId: string;
  state: 'reserved' | 'settled' | 'released';
  createdAt: string;
  settledMicroUsd?: number | undefined;
}

export interface UsageEventRecord {
  id: string;
  tenantId: string;
  jobId: string;
  kind: 'reserve' | 'settle' | 'release';
  microUsd: number;
  at: string;
}

export interface ConfirmationRecord {
  tokenHash: string;
  tenantId: string;
  tool: string;
  requestHash: string;
  estimatedMicroUsd: number;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string | undefined;
}

export interface AuditEventRecord extends AuditEvent {
  id: string;
}

export interface AssetListOptions {
  limit: number;
  cursor?: string | undefined;
  workspaceId?: string | undefined;
}

export interface AssetListResult {
  assets: MediaAsset[];
  nextCursor?: string | undefined;
}

export interface AssetPatch {
  url?: string | undefined;
  urlExpiresAt?: string | undefined;
  storageKey?: string | undefined;
  origin?: MediaAsset['origin'] | undefined;
  sha256?: string | undefined;
}

export interface JobTransaction {
  // --- jobs ---
  insertJob(job: GenerationJob): Promise<void>;
  getJob(tenantId: string, jobId: string): Promise<GenerationJob | undefined>;
  listJobs(tenantId: string, options: JobListOptions): Promise<JobListResult>;
  /** Compare-and-set update. Returns the updated job, or undefined when the guard failed. */
  updateJob(tenantId: string, jobId: string, patch: JobPatch, cas: CasOptions): Promise<GenerationJob | undefined>;
  /**
   * Jobs that still need reconciliation, across all tenants: non-terminal jobs plus
   * jobs cancelled after the provider acknowledged them (their provider work may still
   * be live, so their usage must eventually settle or release).
   */
  listReconcilableJobs(limit: number): Promise<GenerationJob[]>;

  // --- idempotency ---
  getIdempotency(tenantId: string, tool: string, key: string): Promise<IdempotencyRecord | undefined>;
  /** Rejects with INVALID_INPUT when the key exists with a different request hash. */
  putIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord>;

  // --- submissions ---
  putSubmission(envelope: SubmissionEnvelope): Promise<void>;
  getSubmission(tenantId: string, jobId: string): Promise<SubmissionEnvelope | undefined>;
  updateSubmission(tenantId: string, jobId: string, patch: SubmissionPatch): Promise<SubmissionEnvelope | undefined>;
  findSubmissionByCallbackTokenHash(hash: string): Promise<SubmissionEnvelope | undefined>;
  findSubmissionByProviderJobId(tenantId: string, providerJobId: string): Promise<SubmissionEnvelope | undefined>;
  /** Atomically leases submittable envelopes, honouring per-class slot ceilings. */
  claimSubmissions(options: ClaimOptions): Promise<SubmissionEnvelope[]>;
  renewLease(jobId: string, owner: string, leaseTtlMs: number): Promise<boolean>;
  releaseLease(jobId: string, owner: string): Promise<void>;

  // --- usage ---
  reserveUsage(reservation: UsageReservation): Promise<void>;
  getReservation(jobId: string): Promise<UsageReservation | undefined>;
  settleUsage(jobId: string, settledMicroUsd: number, at: string): Promise<void>;
  releaseUsage(jobId: string, at: string): Promise<void>;
  /**
   * Committed estimated spend for one tenant's UTC day: open reservations plus
   * settled amounts (settled uses the settled value), excluding released ones.
   */
  reservedMicroUsdForDay(tenantId: string, day: string): Promise<number>;
  appendUsageEvent(event: UsageEventRecord): Promise<void>;

  // --- confirmations ---
  putConfirmation(record: ConfirmationRecord): Promise<void>;
  getConfirmation(tokenHash: string): Promise<ConfirmationRecord | undefined>;
  /** Atomic single-use consumption. Returns undefined when already consumed. */
  consumeConfirmation(tokenHash: string, consumedAt: string): Promise<ConfirmationRecord | undefined>;

  // --- assets ---
  insertAsset(asset: MediaAsset): Promise<void>;
  getAsset(tenantId: string, assetId: string): Promise<MediaAsset | undefined>;
  listAssets(tenantId: string, options: AssetListOptions): Promise<AssetListResult>;
  updateAsset(tenantId: string, assetId: string, patch: AssetPatch): Promise<MediaAsset | undefined>;

  // --- audit ---
  appendAuditEvent(event: AuditEventRecord): Promise<void>;
}

export interface JobRepository {
  readonly kind: 'memory' | 'postgres';
  /** Serialisable transaction boundary. Domain operations only: never SQL. */
  transaction<T>(fn: (tx: JobTransaction) => Promise<T>): Promise<T>;
  /** Explicit DDL. Replicas never race automatic migrations at startup. */
  migrate(): Promise<void>;
  health(): Promise<void>;
  close(): Promise<void>;
}
