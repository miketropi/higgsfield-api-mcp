import type { GenerationJob, JobListResult, MediaAsset } from '../contracts.js';
import { GatewayError } from '../errors.js';
import type {
  AssetListOptions,
  AssetListResult,
  AssetPatch,
  AuditEventRecord,
  CasOptions,
  ClaimOptions,
  ConfirmationRecord,
  IdempotencyRecord,
  JobPatch,
  JobRepository,
  JobTransaction,
  SubmissionEnvelope,
  SubmissionPatch,
  UsageEventRecord,
  UsageReservation
} from './repository.js';

interface Store {
  jobs: Map<string, GenerationJob>;
  idempotency: Map<string, IdempotencyRecord>;
  submissions: Map<string, SubmissionEnvelope>;
  reservations: Map<string, UsageReservation>;
  usageEvents: UsageEventRecord[];
  confirmations: Map<string, ConfirmationRecord>;
  assets: Map<string, MediaAsset>;
  audit: AuditEventRecord[];
}

const SEP = '\u0000';

const scoped = (tenantId: string, id: string): string => `${tenantId}${SEP}${id}`;

const clone = <T>(value: T): T => structuredClone(value);

/** Copy-on-write merge that ignores explicit `undefined` patch values. */
function mergeDefined<T extends object>(base: T, patch: object): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function emptyStore(): Store {
  return {
    jobs: new Map(),
    idempotency: new Map(),
    submissions: new Map(),
    reservations: new Map(),
    usageEvents: [],
    confirmations: new Map(),
    assets: new Map(),
    audit: []
  };
}

function snapshotOf(store: Store): Store {
  return {
    jobs: new Map(store.jobs),
    idempotency: new Map(store.idempotency),
    submissions: new Map(store.submissions),
    reservations: new Map(store.reservations),
    usageEvents: [...store.usageEvents],
    confirmations: new Map(store.confirmations),
    assets: new Map(store.assets),
    audit: [...store.audit]
  };
}

/** ISO-8601 UTC timestamps compare correctly as strings. */
const atOrBefore = (value: string | undefined, now: string): boolean => value === undefined || value <= now;

function submissionKeyForJob(store: Store, jobId: string): string | undefined {
  for (const [key, envelope] of store.submissions) {
    if (envelope.jobId === jobId) return key;
  }
  return undefined;
}

function compareJobsDesc(a: GenerationJob, b: GenerationJob): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
  return a.createdAt < b.createdAt ? 1 : -1;
}

function createTransaction(store: Store): JobTransaction {
  const requireSubmission = (jobId: string): SubmissionEnvelope => {
    const key = submissionKeyForJob(store, jobId);
    const envelope = key === undefined ? undefined : store.submissions.get(key);
    if (envelope === undefined) {
      throw new GatewayError('INTERNAL_ERROR', `Submission envelope for job ${jobId} was not found.`);
    }
    return envelope;
  };

  const writeSubmission = (envelope: SubmissionEnvelope): void => {
    store.submissions.set(scoped(envelope.tenantId, envelope.jobId), clone(envelope));
  };

  return {
    async insertJob(job) {
      const key = scoped(job.tenantId, job.id);
      if (store.jobs.has(key)) {
        throw new GatewayError('INTERNAL_ERROR', `Job ${job.id} already exists.`);
      }
      store.jobs.set(key, clone(job));
    },

    async getJob(tenantId, jobId) {
      return clone(store.jobs.get(scoped(tenantId, jobId)));
    },

    async listJobs(tenantId, options) {
      const all = [...store.jobs.values()]
        .filter((job) => job.tenantId === tenantId)
        .filter((job) => options.workspaceId === undefined || job.workspaceId === options.workspaceId)
        .sort(compareJobsDesc);
      const start = options.cursor === undefined ? 0 : all.findIndex((job) => job.id === decodeCursor(options.cursor as string));
      const slice = start === -1 ? [] : all.slice(start + (options.cursor === undefined ? 0 : 1));
      const page = slice.slice(0, options.limit);
      const last = page.at(-1);
      const result: JobListResult = { jobs: page.map(clone) };
      if (slice.length > page.length && last !== undefined) result.nextCursor = encodeCursor(last.id);
      return result;
    },

    async updateJob(tenantId, jobId, patch, cas) {
      const key = scoped(tenantId, jobId);
      const current = store.jobs.get(key);
      if (current === undefined) return undefined;
      if (cas.expectStatus !== undefined && !cas.expectStatus.includes(current.status)) return undefined;
      if (cas.expectSubmissionState !== undefined && !cas.expectSubmissionState.includes(current.submissionState)) {
        return undefined;
      }
      const next: GenerationJob = mergeDefined(current, clone(patch));
      store.jobs.set(key, next);
      return clone(next);
    },

    async listReconcilableJobs(limit) {
      return [...store.jobs.values()]
        .filter(
          (job) =>
            job.status === 'queued' ||
            job.status === 'processing' ||
            // An accepted cancellation still has live provider work: keep reconciling so
            // the reservation settles or releases instead of staying reserved forever.
            (job.status === 'cancelled' && job.submissionState === 'acknowledged')
        )
        .sort(compareJobsDesc)
        .slice(0, limit)
        .map(clone);
    },

    async getIdempotency(tenantId, tool, key) {
      return clone(store.idempotency.get(scoped(tenantId, `${tool}${SEP}${key}`)));
    },

    async putIdempotency(record) {
      const key = scoped(record.tenantId, `${record.tool}${SEP}${record.key}`);
      const existing = store.idempotency.get(key);
      if (existing !== undefined) {
        if (existing.requestHash !== record.requestHash) {
          throw new GatewayError(
            'INVALID_INPUT',
            'This idempotency_key was already used with different request parameters.',
            { details: { reason: 'idempotency_key_mismatch' } }
          );
        }
        return clone(existing);
      }
      store.idempotency.set(key, clone(record));
      return clone(record);
    },

    async putSubmission(envelope) {
      writeSubmission(envelope);
    },

    async getSubmission(tenantId, jobId) {
      return clone(store.submissions.get(scoped(tenantId, jobId)));
    },

    async updateSubmission(tenantId, jobId, patch: SubmissionPatch) {
      const key = scoped(tenantId, jobId);
      const current = store.submissions.get(key);
      if (current === undefined) return undefined;
      const next: SubmissionEnvelope = { ...mergeDefined(current, clone(patch)), version: current.version + 1 };
      store.submissions.set(key, next);
      return clone(next);
    },

    async findSubmissionByCallbackTokenHash(hash) {
      const found = [...store.submissions.values()].find((envelope) => envelope.callbackTokenHash === hash);
      return clone(found);
    },

    async findSubmissionByProviderJobId(tenantId, providerJobId) {
      const found = [...store.submissions.values()].find(
        (envelope) => envelope.tenantId === tenantId && envelope.providerJobId === providerJobId
      );
      return clone(found);
    },

    async claimSubmissions(options: ClaimOptions) {
      const claimed: SubmissionEnvelope[] = [];
      const inFlight: Record<string, number> = { image: 0, video: 0, other: 0 };
      const candidates: SubmissionEnvelope[] = [];
      for (const envelope of store.submissions.values()) {
        const leased = envelope.state === 'submitting' && envelope.leaseExpiresAt !== undefined && envelope.leaseExpiresAt > options.now;
        if (leased) inFlight[envelope.concurrencyClass] = (inFlight[envelope.concurrencyClass] ?? 0) + 1;
        const claimable =
          (envelope.state === 'pending' && atOrBefore(envelope.nextAttemptAt, options.now)) ||
          (envelope.state === 'submitting' && !leased);
        if (claimable) candidates.push(envelope);
      }
      candidates.sort((a, b) => (a.createdAt === b.createdAt ? (a.jobId < b.jobId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
      const leaseExpiresAt = new Date(Date.parse(options.now) + options.leaseTtlMs).toISOString();
      for (const candidate of candidates) {
        if (claimed.length >= options.batchLimit) break;
        const ceiling = options.maxPerClass[candidate.concurrencyClass];
        if ((inFlight[candidate.concurrencyClass] ?? 0) >= ceiling) continue;
        const next: SubmissionEnvelope = {
          ...candidate,
          state: 'submitting',
          leaseOwner: options.owner,
          leaseExpiresAt,
          version: candidate.version + 1,
          updatedAt: options.now
        };
        store.submissions.set(scoped(candidate.tenantId, candidate.jobId), next);
        inFlight[candidate.concurrencyClass] = (inFlight[candidate.concurrencyClass] ?? 0) + 1;
        claimed.push(clone(next));
      }
      return claimed;
    },

    async renewLease(jobId, owner, leaseTtlMs) {
      const envelope = requireSubmission(jobId);
      if (envelope.leaseOwner !== owner) return false;
      const base = Date.parse(envelope.leaseExpiresAt ?? envelope.updatedAt);
      envelope.leaseExpiresAt = new Date(base + leaseTtlMs).toISOString();
      envelope.version += 1;
      writeSubmission(envelope);
      return true;
    },

    async releaseLease(jobId, owner) {
      const envelope = requireSubmission(jobId);
      if (envelope.leaseOwner !== owner) return;
      delete envelope.leaseOwner;
      delete envelope.leaseExpiresAt;
      envelope.version += 1;
      writeSubmission(envelope);
    },

    async reserveUsage(reservation) {
      if (store.reservations.has(reservation.jobId)) {
        throw new GatewayError('INTERNAL_ERROR', `Usage reservation for job ${reservation.jobId} already exists.`);
      }
      store.reservations.set(reservation.jobId, clone(reservation));
    },

    async getReservation(jobId) {
      return clone(store.reservations.get(jobId));
    },

    async settleUsage(jobId, settledMicroUsd, _at) {
      const reservation = store.reservations.get(jobId);
      if (reservation === undefined || reservation.state === 'settled') return;
      reservation.state = 'settled';
      reservation.settledMicroUsd = settledMicroUsd;
      store.reservations.set(jobId, reservation);
    },

    async releaseUsage(jobId, _at) {
      const reservation = store.reservations.get(jobId);
      if (reservation === undefined || reservation.state !== 'reserved') return;
      reservation.state = 'released';
      store.reservations.set(jobId, reservation);
    },

    async reservedMicroUsdForDay(tenantId, day) {
      // Committed spend for the UTC day: reservations still open plus what already
      // settled. A completed job must NOT free budget for the rest of the day.
      let total = 0;
      for (const reservation of store.reservations.values()) {
        if (reservation.tenantId !== tenantId || reservation.day !== day) continue;
        if (reservation.state === 'reserved') total += reservation.microUsd;
        else if (reservation.state === 'settled') total += reservation.settledMicroUsd ?? reservation.microUsd;
      }
      return total;
    },

    async appendUsageEvent(event) {
      store.usageEvents.push(clone(event));
    },

    async putConfirmation(record) {
      store.confirmations.set(record.tokenHash, clone(record));
    },

    async getConfirmation(tokenHash) {
      return clone(store.confirmations.get(tokenHash));
    },

    async consumeConfirmation(tokenHash, consumedAt) {
      const record = store.confirmations.get(tokenHash);
      if (record === undefined || record.consumedAt !== undefined) return undefined;
      record.consumedAt = consumedAt;
      store.confirmations.set(tokenHash, record);
      return clone(record);
    },

    async insertAsset(asset) {
      const key = scoped(asset.tenantId, asset.id);
      if (store.assets.has(key)) {
        throw new GatewayError('INTERNAL_ERROR', `Asset ${asset.id} already exists.`);
      }
      store.assets.set(key, clone(asset));
    },

    async getAsset(tenantId, assetId) {
      return clone(store.assets.get(scoped(tenantId, assetId)));
    },

    async listAssets(tenantId, options: AssetListOptions): Promise<AssetListResult> {
      const all = [...store.assets.values()]
        .filter((asset) => asset.tenantId === tenantId)
        .filter((asset) => options.workspaceId === undefined || asset.workspaceId === options.workspaceId)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
      const page = all.slice(0, options.limit);
      const result: AssetListResult = { assets: page.map(clone) };
      const last = page.at(-1);
      if (all.length > page.length && last !== undefined) result.nextCursor = encodeCursor(last.id);
      return result;
    },

    async updateAsset(tenantId, assetId, patch: AssetPatch) {
      const key = scoped(tenantId, assetId);
      const current = store.assets.get(key);
      if (current === undefined) return undefined;
      const next: MediaAsset = mergeDefined(current, clone(patch));
      store.assets.set(key, next);
      return clone(next);
    },

    async appendAuditEvent(event) {
      store.audit.push(clone(event));
    }
  };
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

/**
 * Process-local adapter used for stdio and tests. Transactions are serialized and
 * rolled back on failure; stored values are copies, so callers cannot mutate state.
 */
export function createMemoryJobRepository(): JobRepository {
  let store = emptyStore();
  let queue: Promise<unknown> = Promise.resolve();

  return {
    kind: 'memory',

    transaction<T>(fn: (tx: JobTransaction) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const snapshot = snapshotOf(store);
        try {
          return await fn(createTransaction(store));
        } catch (error) {
          store = snapshot;
          throw error;
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },

    async migrate() {
      await Promise.resolve();
    },

    async health() {
      await Promise.resolve();
    },

    async close() {
      await Promise.resolve();
      store = emptyStore();
    }
  };
}

export type { ClaimOptions, JobPatch, CasOptions };
