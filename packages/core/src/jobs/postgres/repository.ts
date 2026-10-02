/**
 * PostgreSQL implementation of the frozen `JobRepository` port (SPEC §40, §41,
 * §51, §66).
 *
 * Design notes
 * - One transaction per `transaction(fn)` call on a single pooled client:
 *   `BEGIN` → work → `COMMIT`, `ROLLBACK` on throw, client always released. The
 *   caller only ever sees domain operations; SQL never escapes this module.
 * - Isolation is READ COMMITTED with explicit row locks (`FOR UPDATE … SKIP
 *   LOCKED` for claiming). That is what makes concurrent claimers mutually
 *   exclusive without `40001` serialization-failure retry storms.
 * - Submission bodies, query parameters, webhook URLs and callback tokens are
 *   stored as AES-256-GCM envelopes with AAD `${tenantId}:${jobId}`, so a row
 *   copied into another tenant or job cannot be decrypted. A missing encryption
 *   key while a submission must be persisted is fatal — plaintext is never stored.
 * - Patches only ever write the keys they define (`undefined` = "leave alone"),
 *   matching the in-memory adapter; `updated_at` moves only when the domain says
 *   so, because `JobPatch` carries the timestamp.
 * - Every failure leaves this module as a `GatewayError`.
 */
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { decryptJson, encryptJson } from '../../crypto.js';
import { GatewayError } from '../../errors.js';
import type { GenerationJob, JobListResult, LoggerPort } from '../../contracts.js';
import type {
  AssetListOptions,
  AssetListResult,
  AssetPatch,
  AuditEventRecord,
  ClaimOptions,
  ConfirmationRecord,
  IdempotencyRecord,
  JobRepository,
  JobTransaction,
  SubmissionEnvelope,
  SubmissionPatch,
  UsageEventRecord,
  UsageReservation
} from '../repository.js';
import { decodeCursor, encodeCursor } from '../memory-repository.js';
import {
  assetFromRow,
  assetInsertValues,
  confirmationFromRow,
  confirmationInsertValues,
  idempotencyFromRow,
  jobFromRow,
  jobInsertValues,
  readInteger,
  readText,
  reservationFromRow,
  reservationInsertValues,
  submissionFromRow,
  submissionInsertValues
} from './mapping.js';
import type { SqlRow } from './mapping.js';
import { runMigrations } from './migrate.js';

export interface PostgresRepositoryOptions {
  connectionString: string;
  logger: LoggerPort;
  maxConnections?: number;
  statementTimeoutMs?: number;
  /** Required to persist submission envelopes; without it submissions are refused. */
  encryptionKey?: Uint8Array;
  migrationsDir?: string;
}

/** Result shape this module consumes; keeps the driver's generics out of the domain. */
interface SqlResult {
  rows: unknown[];
  rowCount: number | null;
}

interface SqlClient {
  query: (sql: string, values?: unknown[]) => Promise<SqlResult>;
  release: () => void;
}

interface SqlPool {
  query: (sql: string, values?: unknown[]) => Promise<SqlResult>;
  connect: () => Promise<SqlClient>;
  end: () => Promise<void>;
}

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** Patch key → `jobs` column. Anything not listed is not writable through the port. */
const JOB_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  status: 'status',
  providerJobId: 'provider_job_id',
  progress: 'progress',
  assets: 'assets',
  cost: 'cost',
  error: 'error',
  metadata: 'metadata',
  inputSummary: 'input_summary',
  updatedAt: 'updated_at'
};

const JOB_JSONB_COLUMNS: Readonly<Record<string, true>> = {
  assets: true,
  cost: true,
  error: true,
  metadata: true,
  input_summary: true
};

/** Patch key → `submissions` column. */
const SUBMISSION_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  state: 'state',
  attempts: 'attempts',
  providerJobId: 'provider_job_id',
  lastAttemptAt: 'last_attempt_at',
  nextAttemptAt: 'next_attempt_at',
  lastError: 'last_error',
  leaseOwner: 'lease_owner',
  leaseExpiresAt: 'lease_expires_at'
};

const SUBMISSION_JSONB_COLUMNS: Readonly<Record<string, true>> = { last_error: true };

/** Patch key → `assets` column. */
const ASSET_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  url: 'url',
  urlExpiresAt: 'url_expires_at',
  storageKey: 'storage_key',
  origin: 'origin',
  sha256: 'sha256'
};

const SUBMISSION_COLUMNS = [
  'tenant_id',
  'job_id',
  'provider',
  'provider_account_id',
  'job_kind',
  'concurrency_class',
  'endpoint',
  'upstream_idempotency_key',
  'body',
  'body_hash',
  'query_params',
  'webhook_url',
  'callback_token',
  'callback_token_hash',
  'state',
  'attempts',
  'provider_job_id',
  'last_attempt_at',
  'next_attempt_at',
  'last_error',
  'lease_owner',
  'lease_expires_at',
  'version',
  'created_at',
  'updated_at'
] as const;

const JOB_COLUMNS = [
  'tenant_id',
  'id',
  'workspace_id',
  'provider',
  'provider_job_id',
  'capability',
  'model',
  'endpoint',
  'kind',
  'status',
  'progress',
  'created_at',
  'updated_at',
  'input_summary',
  'assets',
  'cost',
  'error',
  'metadata',
  'submission_state',
  'tool',
  'concurrency_class'
] as const;

const SUBMISSION_UPSERT_ASSIGNMENTS = SUBMISSION_COLUMNS.filter(
  (column) => column !== 'tenant_id' && column !== 'job_id'
)
  .map((column) => `${column} = EXCLUDED.${column}`)
  .join(', ');

const SUBMISSION_INSERT_SQL = `INSERT INTO submissions (${SUBMISSION_COLUMNS.join(', ')})
   VALUES (${SUBMISSION_COLUMNS.map((_, index) => `$${index + 1}`).join(', ')})
   ON CONFLICT (tenant_id, job_id) DO UPDATE SET ${SUBMISSION_UPSERT_ASSIGNMENTS}`;

function placeholders(columns: readonly string[]): string {
  return columns.map((_, index) => `$${index + 1}`).join(', ');
}

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Builds `column = $n` assignments for the patch keys that are present and
 * defined, appending the values to `values`. `undefined` means "leave unchanged",
 * which is what the in-memory adapter does too.
 */
function buildAssignments(
  columnByKey: Readonly<Record<string, string>>,
  jsonbColumns: Readonly<Record<string, true>>,
  patch: object,
  values: unknown[]
): string[] {
  const assignments: string[] = [];
  const patchValues = patch as Record<string, unknown>;
  for (const [key, column] of Object.entries(columnByKey)) {
    const value = patchValues[key];
    if (value === undefined) continue;
    values.push(jsonbColumns[column] === true ? asJson(value) : value);
    assignments.push(`${column} = $${values.length}`);
  }
  return assignments;
}

/** Wraps a driver failure so callers always receive a `GatewayError`. */
function databaseFailure(operation: string, error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  const name = error instanceof Error ? error.name : 'UnknownError';
  return new GatewayError('INTERNAL_ERROR', `Database operation failed: ${operation}.`, {
    retryable: true,
    details: { component: 'postgres_repository', operation, driverCode: code, driverError: name },
    cause: error
  });
}

function driverErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function pageOfJobs(selected: SqlRow[], limit: number): JobListResult {
  const page = selected.slice(0, limit);
  const result: JobListResult = { jobs: page.map(jobFromRow) };
  const last = page.at(-1);
  if (selected.length > page.length && last !== undefined) result.nextCursor = encodeCursor(readText(last, 'id'));
  return result;
}

export function createPostgresJobRepository(options: PostgresRepositoryOptions): JobRepository {
  const { connectionString, logger, encryptionKey } = options;
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const poolConfig: PoolConfig = {
    connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    application_name: 'higgsfield-mcp',
    // Applied per session by the driver; each transaction re-asserts it locally.
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: statementTimeoutMs,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS
  };
  const pool = new Pool(poolConfig);
  // A dropped idle client must not crash the process.
  pool.on('error', (error: Error) => {
    logger.warn({ component: 'postgres_repository', event: 'pool_error', error: error.name }, 'postgres pool error');
  });

  const db: SqlPool = {
    query: (sql, values) => pool.query(sql, values),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, values) => client.query(sql, values),
        release: () => client.release()
      };
    },
    end: () => pool.end()
  };

  let closed = false;

  /**
   * Encrypts one envelope column. Absent values stay SQL NULL; a missing key is
   * fatal because storing these plaintext would leak a webhook/callback secret.
   */
  const encodeColumn = (context: string, column: string, value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (encryptionKey === undefined) {
      throw new GatewayError('INTERNAL_ERROR', 'Submission envelope encryption key is not configured.', {
        details: { component: 'postgres_repository', column }
      });
    }
    return encryptJson(encryptionKey, context, value);
  };

  const decodeColumn = (context: string, column: string, value: unknown): unknown => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || encryptionKey === undefined) {
      throw new GatewayError('INTERNAL_ERROR', 'Stored submission column is not a readable encrypted envelope.', {
        details: { component: 'postgres_repository', column }
      });
    }
    return decryptJson(encryptionKey, context, value);
  };

  const submissionValues = (envelope: SubmissionEnvelope): unknown[] => {
    const context = `${envelope.tenantId}:${envelope.jobId}`;
    return submissionInsertValues({
      tenantId: envelope.tenantId,
      jobId: envelope.jobId,
      provider: envelope.provider,
      providerAccountId: envelope.providerAccountId,
      jobKind: envelope.jobKind,
      concurrencyClass: envelope.concurrencyClass,
      endpoint: envelope.endpoint,
      upstreamIdempotencyKey: envelope.upstreamIdempotencyKey,
      body: encodeColumn(context, 'body', envelope.body) as string,
      bodyHash: envelope.bodyHash,
      query: encodeColumn(context, 'query_params', envelope.query),
      webhookUrl: encodeColumn(context, 'webhook_url', envelope.webhookUrl),
      callbackToken: encodeColumn(context, 'callback_token', envelope.callbackToken),
      callbackTokenHash: envelope.callbackTokenHash ?? null,
      state: envelope.state,
      attempts: envelope.attempts,
      providerJobId: envelope.providerJobId ?? null,
      lastAttemptAt: envelope.lastAttemptAt ?? null,
      nextAttemptAt: envelope.nextAttemptAt ?? null,
      lastError: envelope.lastError === undefined ? null : asJson(envelope.lastError),
      leaseOwner: envelope.leaseOwner ?? null,
      leaseExpiresAt: envelope.leaseExpiresAt ?? null,
      version: envelope.version,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt
    });
  };

  const submissionRow = (row: SqlRow): SubmissionEnvelope => {
    const tenantId = readText(row, 'tenant_id');
    const jobId = readText(row, 'job_id');
    const context = `${tenantId}:${jobId}`;
    return submissionFromRow(row, (_scope, column, value) => decodeColumn(context, column, value));
  };

  const createTransaction = (client: SqlClient): JobTransaction => {
    const query = client.query;
    const rows = async (sql: string, values?: unknown[]): Promise<SqlRow[]> => {
      const result = await query(sql, values);
      return result.rows as SqlRow[];
    };

    /**
     * Transaction-scoped advisory lock keyed on `tenant_id:day`. Taking it before
     * the budget sum serialises the read-then-reserve admission pattern: a second
     * admission for the same tenant/day waits here until the first commits, so it
     * cannot observe a stale total and overshoot the daily ceiling.
     */
    const lockTenantDay = async (tenantId: string, day: string): Promise<void> => {
      await query('SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)', [`${tenantId}:${day}`]);
    };

    return {
      // --- jobs -----------------------------------------------------------
      async insertJob(job) {
        const result = await query(
          `INSERT INTO jobs (${JOB_COLUMNS.join(', ')}) VALUES (${placeholders(JOB_COLUMNS)})
           ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`,
          jobInsertValues(job)
        );
        if (result.rows.length === 0) {
          throw new GatewayError('INTERNAL_ERROR', `Job ${job.id} already exists.`);
        }
      },

      async getJob(tenantId, jobId) {
        const found = await rows('SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2', [tenantId, jobId]);
        const row = found[0];
        return row === undefined ? undefined : jobFromRow(row);
      },

      async listJobs(tenantId, options): Promise<JobListResult> {
        const workspaceFilter = options.workspaceId === undefined ? '' : ' AND workspace_id = $2';
        const values: unknown[] = options.workspaceId === undefined ? [tenantId] : [tenantId, options.workspaceId];
        if (options.cursor === undefined) {
          const selected = await rows(
            `SELECT * FROM jobs WHERE tenant_id = $1${workspaceFilter}
             ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1}`,
            [...values, options.limit + 1]
          );
          return pageOfJobs(selected, options.limit);
        }
        // The cursor is the id of the last returned job: resolve its sort key, then
        // take the rows strictly after it in (created_at DESC, id DESC) order.
        const cursorId = decodeCursor(options.cursor);
        const anchor = await rows('SELECT created_at FROM jobs WHERE tenant_id = $1 AND id = $2', [tenantId, cursorId]);
        const anchorRow = anchor[0];
        if (anchorRow === undefined) return { jobs: [] };
        const selected = await rows(
          `SELECT * FROM jobs WHERE tenant_id = $1${workspaceFilter}
             AND (created_at, id) < ($${values.length + 1}::timestamptz, $${values.length + 2})
           ORDER BY created_at DESC, id DESC LIMIT $${values.length + 3}`,
          [...values, anchorRow['created_at'], cursorId, options.limit + 1]
        );
        return pageOfJobs(selected, options.limit);
      },

      async updateJob(tenantId, jobId, patch, cas): Promise<GenerationJob | undefined> {
        const values: unknown[] = [tenantId, jobId];
        const assignments = buildAssignments(JOB_PATCH_COLUMNS, JOB_JSONB_COLUMNS, patch, values);
        if (assignments.length === 0) {
          // Defensive: `updatedAt` is required by the port, so this only triggers for
          // an untyped caller passing `undefined`; keep the CAS guard meaningful.
          assignments.push('updated_at = updated_at');
        }
        let guard = '';
        if (cas.expectStatus !== undefined) {
          values.push(cas.expectStatus);
          guard += ` AND status = ANY($${values.length}::text[])`;
        }
        if (cas.expectSubmissionState !== undefined) {
          values.push(cas.expectSubmissionState);
          guard += ` AND submission_state = ANY($${values.length}::text[])`;
        }
        const updated = await rows(
          `UPDATE jobs SET ${assignments.join(', ')}
           WHERE tenant_id = $1 AND id = $2${guard} RETURNING *`,
          values
        );
        const row = updated[0];
        return row === undefined ? undefined : jobFromRow(row);
      },

      async listReconcilableJobs(limit) {
        // Non-terminal work plus cancellations the provider already acknowledged: the
        // provider job may still be live, so its usage must eventually settle or
        // release instead of staying `reserved` for the rest of the UTC day.
        const selected = await rows(
          `SELECT * FROM jobs
           WHERE status IN ('queued', 'processing')
              OR (status = 'cancelled' AND submission_state = 'acknowledged')
           ORDER BY created_at DESC, id DESC LIMIT $1`,
          [limit]
        );
        return selected.map(jobFromRow);
      },

      // --- idempotency ----------------------------------------------------
      async getIdempotency(tenantId, tool, key) {
        const found = await rows('SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND tool = $2 AND key = $3', [
          tenantId,
          tool,
          key
        ]);
        const row = found[0];
        return row === undefined ? undefined : idempotencyFromRow(row);
      },

      /**
       * Atomic claim: the insert either wins (this call owns the key) or is a no-op,
       * in which case the *stored* row is returned unchanged. An existing row's
       * `job_id` and `request_hash` are never overwritten, so callers can treat the
       * returned `jobId` as authoritative and roll back the job they just inserted
       * when it differs — two concurrent admissions cannot both hold one client key.
       */
      async putIdempotency(record): Promise<IdempotencyRecord> {
        const inserted = await rows(
          `INSERT INTO idempotency_keys (tenant_id, tool, key, request_hash, job_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, tool, key) DO NOTHING RETURNING *`,
          [record.tenantId, record.tool, record.key, record.requestHash, record.jobId, record.createdAt]
        );
        const insertedRow = inserted[0];
        if (insertedRow !== undefined) return idempotencyFromRow(insertedRow);

        const existing = await rows('SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND tool = $2 AND key = $3', [
          record.tenantId,
          record.tool,
          record.key
        ]);
        const existingRow = existing[0];
        if (existingRow === undefined) {
          // Lost a race against a concurrent delete; surface it rather than silently
          // returning a key that no longer exists.
          throw new GatewayError('INTERNAL_ERROR', 'Idempotency key conflicted without an existing record.');
        }
        const stored = idempotencyFromRow(existingRow);
        if (stored.requestHash !== record.requestHash) {
          throw new GatewayError(
            'INVALID_INPUT',
            'This idempotency_key was already used with different request parameters.',
            { details: { reason: 'idempotency_key_mismatch' } }
          );
        }
        return stored;
      },

      // --- submissions ----------------------------------------------------
      async putSubmission(envelope) {
        await query(SUBMISSION_INSERT_SQL, submissionValues(envelope));
      },

      async getSubmission(tenantId, jobId) {
        const found = await rows('SELECT * FROM submissions WHERE tenant_id = $1 AND job_id = $2', [tenantId, jobId]);
        const row = found[0];
        return row === undefined ? undefined : submissionRow(row);
      },

      async updateSubmission(tenantId, jobId, patch: SubmissionPatch) {
        const values: unknown[] = [tenantId, jobId];
        const assignments = buildAssignments(SUBMISSION_PATCH_COLUMNS, SUBMISSION_JSONB_COLUMNS, patch, values);
        assignments.push('version = version + 1');
        const updated = await rows(
          `UPDATE submissions SET ${assignments.join(', ')}
           WHERE tenant_id = $1 AND job_id = $2 RETURNING *`,
          values
        );
        const row = updated[0];
        return row === undefined ? undefined : submissionRow(row);
      },

      async findSubmissionByCallbackTokenHash(hash) {
        const found = await rows('SELECT * FROM submissions WHERE callback_token_hash = $1', [hash]);
        const row = found[0];
        return row === undefined ? undefined : submissionRow(row);
      },

      async findSubmissionByProviderJobId(tenantId, providerJobId) {
        const found = await rows('SELECT * FROM submissions WHERE tenant_id = $1 AND provider_job_id = $2', [
          tenantId,
          providerJobId
        ]);
        const row = found[0];
        return row === undefined ? undefined : submissionRow(row);
      },

      async claimSubmissions(options: ClaimOptions): Promise<SubmissionEnvelope[]> {
        // In-flight leases per class, counted inside this transaction so the ceilings
        // and the claims below are consistent with each other.
        const inFlight: Record<string, number> = { image: 0, video: 0, other: 0 };
        const counted = await rows(
          `SELECT concurrency_class, count(*)::int AS in_flight FROM submissions
           WHERE state = 'submitting' AND lease_expires_at IS NOT NULL AND lease_expires_at > $1::timestamptz
           GROUP BY concurrency_class`,
          [options.now]
        );
        for (const row of counted) inFlight[readText(row, 'concurrency_class')] = readInteger(row, 'in_flight');

        const candidates = await rows(
          `SELECT * FROM submissions
           WHERE (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz))
              OR (state = 'submitting' AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz))
           ORDER BY created_at ASC, job_id ASC
           FOR UPDATE SKIP LOCKED`,
          [options.now]
        );

        const leaseExpiresAt = new Date(Date.parse(options.now) + options.leaseTtlMs).toISOString();
        const claimed: SubmissionEnvelope[] = [];
        for (const row of candidates) {
          if (claimed.length >= options.batchLimit) break;
          const concurrencyClass = readText(row, 'concurrency_class');
          const ceiling = options.maxPerClass[concurrencyClass as keyof ClaimOptions['maxPerClass']];
          if ((inFlight[concurrencyClass] ?? 0) >= ceiling) continue;
          const updated = await rows(
            `UPDATE submissions
             SET state = 'submitting', lease_owner = $3, lease_expires_at = $4::timestamptz,
                 version = version + 1, updated_at = $5::timestamptz
             WHERE tenant_id = $1 AND job_id = $2 RETURNING *`,
            [readText(row, 'tenant_id'), readText(row, 'job_id'), options.owner, leaseExpiresAt, options.now]
          );
          const claimedRow = updated[0];
          if (claimedRow === undefined) continue;
          inFlight[concurrencyClass] = (inFlight[concurrencyClass] ?? 0) + 1;
          claimed.push(submissionRow(claimedRow));
        }
        return claimed;
      },

      async renewLease(jobId, owner, leaseTtlMs) {
        const existing = await rows('SELECT tenant_id FROM submissions WHERE job_id = $1', [jobId]);
        if (existing[0] === undefined) {
          throw new GatewayError('INTERNAL_ERROR', `Submission envelope for job ${jobId} was not found.`);
        }
        const updated = await rows(
          `UPDATE submissions
           SET lease_expires_at = COALESCE(lease_expires_at, updated_at) + ($3::double precision * interval '1 millisecond'),
               version = version + 1
           WHERE job_id = $1 AND lease_owner = $2 RETURNING job_id`,
          [jobId, owner, leaseTtlMs]
        );
        return updated.length > 0;
      },

      async releaseLease(jobId, owner) {
        const existing = await rows('SELECT tenant_id FROM submissions WHERE job_id = $1', [jobId]);
        if (existing[0] === undefined) {
          throw new GatewayError('INTERNAL_ERROR', `Submission envelope for job ${jobId} was not found.`);
        }
        await query(
          `UPDATE submissions SET lease_owner = NULL, lease_expires_at = NULL, version = version + 1
           WHERE job_id = $1 AND lease_owner = $2`,
          [jobId, owner]
        );
      },

      // --- usage ----------------------------------------------------------
      async reserveUsage(reservation: UsageReservation) {
        // Same lock as the budget read: an admission that skips the sum is still
        // serialised against one that does not.
        await lockTenantDay(reservation.tenantId, reservation.day);
        const inserted = await query(
          `INSERT INTO usage_reservations (job_id, tenant_id, day, micro_usd, provider_account_id, state, created_at, settled_micro_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (job_id) DO NOTHING RETURNING job_id`,
          reservationInsertValues(reservation)
        );
        if (inserted.rows.length === 0) {
          throw new GatewayError('INTERNAL_ERROR', `Usage reservation for job ${reservation.jobId} already exists.`);
        }
      },

      async getReservation(jobId) {
        const found = await rows('SELECT * FROM usage_reservations WHERE job_id = $1', [jobId]);
        const row = found[0];
        return row === undefined ? undefined : reservationFromRow(row);
      },

      async settleUsage(jobId, settledMicroUsd, _at) {
        await query(
          `UPDATE usage_reservations SET state = 'settled', settled_micro_usd = $2
           WHERE job_id = $1 AND state <> 'settled'`,
          [jobId, settledMicroUsd]
        );
      },

      async releaseUsage(jobId, _at) {
        await query(`UPDATE usage_reservations SET state = 'released' WHERE job_id = $1 AND state = 'reserved'`, [
          jobId
        ]);
      },

      async reservedMicroUsdForDay(tenantId, day) {
        // Serialise the read-then-reserve admission check for this tenant/day.
        await lockTenantDay(tenantId, day);
        const found = await rows(
          `SELECT COALESCE(SUM(
             CASE
               WHEN state = 'reserved' THEN micro_usd
               WHEN state = 'settled' THEN COALESCE(settled_micro_usd, micro_usd)
               ELSE 0
             END), 0)::bigint AS total
           FROM usage_reservations
           WHERE tenant_id = $1 AND day = $2`,
          [tenantId, day]
        );
        const row = found[0];
        return row === undefined ? 0 : readInteger(row, 'total');
      },

      async appendUsageEvent(event: UsageEventRecord) {
        await query(
          `INSERT INTO usage_events (id, tenant_id, job_id, kind, micro_usd, at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [event.id, event.tenantId, event.jobId, event.kind, event.microUsd, event.at]
        );
      },

      // --- confirmations --------------------------------------------------
      async putConfirmation(record: ConfirmationRecord) {
        // An existing row always wins: a consumed token is never resurrected.
        await query(
          `INSERT INTO confirmations (token_hash, tenant_id, tool, request_hash, estimated_micro_usd, expires_at, created_at, consumed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (token_hash) DO NOTHING`,
          confirmationInsertValues(record)
        );
      },

      async getConfirmation(tokenHash) {
        const found = await rows('SELECT * FROM confirmations WHERE token_hash = $1', [tokenHash]);
        const row = found[0];
        return row === undefined ? undefined : confirmationFromRow(row);
      },

      async consumeConfirmation(tokenHash, consumedAt) {
        const updated = await rows(
          `UPDATE confirmations SET consumed_at = $2 WHERE token_hash = $1 AND consumed_at IS NULL RETURNING *`,
          [tokenHash, consumedAt]
        );
        const row = updated[0];
        return row === undefined ? undefined : confirmationFromRow(row);
      },

      // --- assets ---------------------------------------------------------
      async insertAsset(asset) {
        const result = await query(
          `INSERT INTO assets (tenant_id, id, workspace_id, provider, media_type, mime_type, size, url, created_at,
             width, height, duration_seconds, origin, storage_key, url_expires_at, sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`,
          assetInsertValues(asset)
        );
        if (result.rows.length === 0) {
          throw new GatewayError('INTERNAL_ERROR', `Asset ${asset.id} already exists.`);
        }
      },

      async getAsset(tenantId, assetId) {
        const found = await rows('SELECT * FROM assets WHERE tenant_id = $1 AND id = $2', [tenantId, assetId]);
        const row = found[0];
        return row === undefined ? undefined : assetFromRow(row);
      },

      async listAssets(tenantId, options: AssetListOptions): Promise<AssetListResult> {
        const workspaceFilter = options.workspaceId === undefined ? '' : ' AND workspace_id = $2';
        const values: unknown[] = options.workspaceId === undefined ? [tenantId] : [tenantId, options.workspaceId];
        const selected = await rows(
          `SELECT * FROM assets WHERE tenant_id = $1${workspaceFilter}
           ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1}`,
          [...values, options.limit + 1]
        );
        const page = selected.slice(0, options.limit);
        const result: AssetListResult = { assets: page.map(assetFromRow) };
        const last = page.at(-1);
        if (selected.length > page.length && last !== undefined) result.nextCursor = encodeCursor(readText(last, 'id'));
        return result;
      },

      async updateAsset(tenantId, assetId, patch: AssetPatch) {
        const values: unknown[] = [tenantId, assetId];
        const assignments = buildAssignments(ASSET_PATCH_COLUMNS, {}, patch, values);
        if (assignments.length === 0) assignments.push('id = id');
        const updated = await rows(
          `UPDATE assets SET ${assignments.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          values
        );
        const row = updated[0];
        return row === undefined ? undefined : assetFromRow(row);
      },

      // --- audit ----------------------------------------------------------
      async appendAuditEvent(event: AuditEventRecord) {
        await query(
          `INSERT INTO audit_events (id, tenant_id, at, event, job_id, asset_id, token_id, request_id, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.id,
            event.tenantId,
            event.at,
            event.event,
            event.jobId ?? null,
            event.assetId ?? null,
            event.tokenId ?? null,
            event.requestId ?? null,
            event.details === undefined ? null : asJson(event.details)
          ]
        );
      }
    };
  };

  return {
    kind: 'postgres',

    async transaction<T>(fn: (tx: JobTransaction) => Promise<T>): Promise<T> {
      let client: SqlClient | undefined;
      let begun = false;
      try {
        client = await db.connect();
        await client.query('BEGIN');
        begun = true;
        // Transaction-local: the pooled session may be reused by another tenant.
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
        const result = await fn(createTransaction(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (client !== undefined && begun) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            logger.warn(
              { component: 'postgres_repository', event: 'rollback_failed', error: driverErrorName(rollbackError) },
              'postgres rollback failed'
            );
          }
        }
        throw databaseFailure('transaction', error);
      } finally {
        client?.release();
      }
    },

    /** Explicit DDL only: never called implicitly by the adapter. */
    async migrate() {
      await runMigrations({
        connectionString,
        logger,
        ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir })
      });
    },

    async health() {
      try {
        await db.query('SELECT 1');
      } catch (error) {
        throw databaseFailure('health', error);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      await db.end();
    }
  };
}
