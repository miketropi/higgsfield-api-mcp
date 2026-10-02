/**
 * Row ↔ domain mapping for the PostgreSQL adapter.
 *
 * The driver returns columns as `unknown` as far as this file is concerned: every
 * value is read through an accessor that validates the shape and raises
 * `INTERNAL_ERROR` on anything unexpected, so a schema drift or a corrupt column
 * surfaces as a structured gateway error rather than `undefined` propagating into
 * a job record.
 *
 * Timestamps are stored as `timestamptz` and always converted to ISO-8601 UTC
 * strings, which compares correctly as a string and matches the in-memory adapter.
 */
import { GatewayError } from '../../errors.js';
import type {
  CostInfo,
  GenerationJob,
  JobKind,
  JobStatus,
  MediaAsset,
  MediaType,
  StructuredError,
  SubmissionState
} from '../../contracts.js';
import type { ConfirmationRecord, IdempotencyRecord, SubmissionEnvelope, UsageReservation } from '../repository.js';

export type SqlRow = Record<string, unknown>;

function corrupt(column: string, expected: string): GatewayError {
  return new GatewayError('INTERNAL_ERROR', `Stored column ${column} is not ${expected}.`, {
    details: { component: 'postgres_repository', column }
  });
}

export function readText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw corrupt(column, 'text');
  return value;
}

export function readOptionalText(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw corrupt(column, 'text');
  return value;
}

/** `timestamptz` → ISO-8601 UTC. Accepts `Date` (driver) and ISO text. */
export function readTimestamp(row: SqlRow, column: string): string {
  const value = row[column];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw corrupt(column, 'a timestamp');
    return parsed.toISOString();
  }
  throw corrupt(column, 'a timestamp');
}

export function readOptionalTimestamp(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return readTimestamp(row, column);
}

export function readOptionalNumber(row: SqlRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw corrupt(column, 'a number');
  return parsed;
}

export function readOptionalInteger(row: SqlRow, column: string): number | undefined {
  const parsed = readOptionalNumber(row, column);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) throw corrupt(column, 'an integer');
  return parsed;
}

/** `bigint` columns arrive as strings; the gateway's money type is a safe integer. */
export function readInteger(row: SqlRow, column: string): number {
  const parsed = readOptionalInteger(row, column);
  if (parsed === undefined) throw corrupt(column, 'an integer');
  return parsed;
}

export function readJson<T>(row: SqlRow, column: string): T {
  const value = row[column];
  if (value === null || value === undefined) throw corrupt(column, 'JSON');
  return value as T;
}

export function readOptionalJson<T>(row: SqlRow, column: string): T | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return value as T;
}

// ---------------------------------------------------------------------------
// Domain → row values
// ---------------------------------------------------------------------------

export function jobInsertValues(job: GenerationJob): unknown[] {
  return [
    job.tenantId,
    job.id,
    job.workspaceId ?? null,
    job.provider,
    job.providerJobId ?? null,
    job.capability,
    job.model ?? null,
    job.endpoint ?? null,
    job.kind,
    job.status,
    job.progress ?? null,
    job.createdAt,
    job.updatedAt,
    JSON.stringify(job.inputSummary),
    JSON.stringify(job.assets),
    job.cost === undefined ? null : JSON.stringify(job.cost),
    job.error === undefined ? null : JSON.stringify(job.error),
    job.metadata === undefined ? null : JSON.stringify(job.metadata),
    job.submissionState,
    job.tool,
    job.concurrencyClass
  ];
}

export function assetInsertValues(asset: MediaAsset): unknown[] {
  return [
    asset.tenantId,
    asset.id,
    asset.workspaceId ?? null,
    asset.provider,
    asset.mediaType,
    asset.mimeType,
    asset.size ?? null,
    asset.url,
    asset.createdAt,
    asset.width ?? null,
    asset.height ?? null,
    asset.durationSeconds ?? null,
    asset.origin,
    asset.storageKey ?? null,
    asset.urlExpiresAt ?? null,
    asset.sha256 ?? null
  ];
}

export function submissionInsertValues(envelope: {
  tenantId: string;
  jobId: string;
  provider: string;
  providerAccountId: string;
  jobKind: JobKind;
  concurrencyClass: SubmissionEnvelope['concurrencyClass'];
  endpoint: string;
  upstreamIdempotencyKey: string;
  body: string;
  bodyHash: string;
  query: string | null;
  webhookUrl: string | null;
  callbackToken: string | null;
  callbackTokenHash: string | null;
  state: SubmissionState;
  attempts: number;
  providerJobId: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}): unknown[] {
  const e = envelope;
  return [
    e.tenantId,
    e.jobId,
    e.provider,
    e.providerAccountId,
    e.jobKind,
    e.concurrencyClass,
    e.endpoint,
    e.upstreamIdempotencyKey,
    e.body,
    e.bodyHash,
    e.query,
    e.webhookUrl,
    e.callbackToken,
    e.callbackTokenHash,
    e.state,
    e.attempts,
    e.providerJobId,
    e.lastAttemptAt,
    e.nextAttemptAt,
    e.lastError,
    e.leaseOwner,
    e.leaseExpiresAt,
    e.version,
    e.createdAt,
    e.updatedAt
  ];
}

export function reservationInsertValues(reservation: UsageReservation): unknown[] {
  return [
    reservation.jobId,
    reservation.tenantId,
    reservation.day,
    reservation.microUsd,
    reservation.providerAccountId,
    reservation.state,
    reservation.createdAt,
    reservation.settledMicroUsd ?? null
  ];
}

export function confirmationInsertValues(record: ConfirmationRecord): unknown[] {
  return [
    record.tokenHash,
    record.tenantId,
    record.tool,
    record.requestHash,
    record.estimatedMicroUsd,
    record.expiresAt,
    record.createdAt,
    record.consumedAt ?? null
  ];
}

// ---------------------------------------------------------------------------
// Row → domain
// ---------------------------------------------------------------------------

export function jobFromRow(row: SqlRow): GenerationJob {
  const workspaceId = readOptionalText(row, 'workspace_id');
  const providerJobId = readOptionalText(row, 'provider_job_id');
  const model = readOptionalText(row, 'model');
  const endpoint = readOptionalText(row, 'endpoint');
  const progress = readOptionalNumber(row, 'progress');
  const cost = readOptionalJson<CostInfo>(row, 'cost');
  const error = readOptionalJson<StructuredError>(row, 'error');
  const metadata = readOptionalJson<Record<string, unknown>>(row, 'metadata');
  return {
    id: readText(row, 'id'),
    tenantId: readText(row, 'tenant_id'),
    provider: readText(row, 'provider'),
    capability: readText(row, 'capability'),
    kind: readText(row, 'kind') as JobKind,
    status: readText(row, 'status') as JobStatus,
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
    inputSummary: readJson<Record<string, unknown>>(row, 'input_summary'),
    assets: readJson<MediaAsset[]>(row, 'assets'),
    submissionState: readText(row, 'submission_state') as SubmissionState,
    tool: readText(row, 'tool'),
    concurrencyClass: readText(row, 'concurrency_class') as GenerationJob['concurrencyClass'],
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(providerJobId === undefined ? {} : { providerJobId }),
    ...(model === undefined ? {} : { model }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(progress === undefined ? {} : { progress }),
    ...(cost === undefined ? {} : { cost }),
    ...(error === undefined ? {} : { error }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

export function assetFromRow(row: SqlRow): MediaAsset {
  const workspaceId = readOptionalText(row, 'workspace_id');
  const size = readOptionalInteger(row, 'size');
  const width = readOptionalInteger(row, 'width');
  const height = readOptionalInteger(row, 'height');
  const durationSeconds = readOptionalNumber(row, 'duration_seconds');
  const storageKey = readOptionalText(row, 'storage_key');
  const urlExpiresAt = readOptionalTimestamp(row, 'url_expires_at');
  const sha256 = readOptionalText(row, 'sha256');
  return {
    id: readText(row, 'id'),
    tenantId: readText(row, 'tenant_id'),
    provider: readText(row, 'provider'),
    mediaType: readText(row, 'media_type') as MediaType,
    mimeType: readText(row, 'mime_type'),
    url: readText(row, 'url'),
    createdAt: readTimestamp(row, 'created_at'),
    origin: readText(row, 'origin') as MediaAsset['origin'],
    ...(size === undefined ? {} : { size }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(storageKey === undefined ? {} : { storageKey }),
    ...(urlExpiresAt === undefined ? {} : { urlExpiresAt }),
    ...(sha256 === undefined ? {} : { sha256 })
  };
}

/**
 * Rebuilds a submission envelope, decrypting the encrypted columns. `decode` is
 * supplied by the repository so the encryption key never leaves it.
 */
export function submissionFromRow(
  row: SqlRow,
  decode: (context: { tenantId: string; jobId: string }, column: string, value: unknown) => unknown
): SubmissionEnvelope {
  const tenantId = readText(row, 'tenant_id');
  const jobId = readText(row, 'job_id');
  const context = { tenantId, jobId };
  const query = decode(context, 'query_params', row['query_params']) as Record<string, string> | undefined;
  const webhookUrl = decode(context, 'webhook_url', row['webhook_url']) as string | undefined;
  const callbackToken = decode(context, 'callback_token', row['callback_token']) as string | undefined;
  const lastError = readOptionalJson<StructuredError>(row, 'last_error');
  const providerJobId = readOptionalText(row, 'provider_job_id');
  const callbackTokenHash = readOptionalText(row, 'callback_token_hash');
  const lastAttemptAt = readOptionalTimestamp(row, 'last_attempt_at');
  const nextAttemptAt = readOptionalTimestamp(row, 'next_attempt_at');
  const leaseOwner = readOptionalText(row, 'lease_owner');
  const leaseExpiresAt = readOptionalTimestamp(row, 'lease_expires_at');
  return {
    jobId,
    tenantId,
    provider: readText(row, 'provider'),
    providerAccountId: readText(row, 'provider_account_id'),
    jobKind: readText(row, 'job_kind') as JobKind,
    concurrencyClass: readText(row, 'concurrency_class') as SubmissionEnvelope['concurrencyClass'],
    endpoint: readText(row, 'endpoint'),
    upstreamIdempotencyKey: readText(row, 'upstream_idempotency_key'),
    body: decode(context, 'body', row['body']) as Record<string, unknown>,
    bodyHash: readText(row, 'body_hash'),
    state: readText(row, 'state') as SubmissionState,
    attempts: readInteger(row, 'attempts'),
    version: readInteger(row, 'version'),
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
    ...(query === undefined ? {} : { query }),
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
    ...(callbackToken === undefined ? {} : { callbackToken }),
    ...(callbackTokenHash === undefined ? {} : { callbackTokenHash }),
    ...(providerJobId === undefined ? {} : { providerJobId }),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt })
  };
}

export function idempotencyFromRow(row: SqlRow): IdempotencyRecord {
  return {
    tenantId: readText(row, 'tenant_id'),
    tool: readText(row, 'tool'),
    key: readText(row, 'key'),
    requestHash: readText(row, 'request_hash'),
    jobId: readText(row, 'job_id'),
    createdAt: readTimestamp(row, 'created_at')
  };
}

export function reservationFromRow(row: SqlRow): UsageReservation {
  const settledMicroUsd = readOptionalInteger(row, 'settled_micro_usd');
  return {
    jobId: readText(row, 'job_id'),
    tenantId: readText(row, 'tenant_id'),
    day: readText(row, 'day'),
    microUsd: readInteger(row, 'micro_usd'),
    providerAccountId: readText(row, 'provider_account_id'),
    state: readText(row, 'state') as UsageReservation['state'],
    createdAt: readTimestamp(row, 'created_at'),
    ...(settledMicroUsd === undefined ? {} : { settledMicroUsd })
  };
}

export function confirmationFromRow(row: SqlRow): ConfirmationRecord {
  const consumedAt = readOptionalTimestamp(row, 'consumed_at');
  return {
    tokenHash: readText(row, 'token_hash'),
    tenantId: readText(row, 'tenant_id'),
    tool: readText(row, 'tool'),
    requestHash: readText(row, 'request_hash'),
    estimatedMicroUsd: readInteger(row, 'estimated_micro_usd'),
    expiresAt: readTimestamp(row, 'expires_at'),
    createdAt: readTimestamp(row, 'created_at'),
    ...(consumedAt === undefined ? {} : { consumedAt })
  };
}
