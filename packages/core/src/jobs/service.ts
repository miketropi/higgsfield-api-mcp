import type {
  Clock,
  GenerationJob,
  MediaAsset,
  JobListResult,
  JobService,
  JobStatus,
  LoggerPort,
  ProviderFactory,
  RequestContext
} from '../contracts.js';
import { GatewayError } from '../errors.js';
import type { JobRepository } from './repository.js';

export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];
export const DEFAULT_WAIT_MAX_MS = 25_000;
const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_POLL_MS = 750;
const LIST_LIMIT = 50;

export interface JobServiceOptions {
  repository: JobRepository;
  providerFactory: ProviderFactory;
  clock: Clock;
  logger: LoggerPort;
  waitDefaultMs?: number | undefined;
  waitMaxMs?: number | undefined;
  waitPollMs?: number | undefined;
  /**
   * Refreshes asset URLs on read. Managed assets are exposed through short-lived
   * signed URLs, so a job read must re-sign (or drop) an expired one instead of
   * handing the client a dead link.
   */
  assets?: { refresh(job: GenerationJob, context: RequestContext): Promise<MediaAsset[]> } | undefined;
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

function requireTenant(context: RequestContext): string {
  if (context.tenantId === undefined || context.tenantId.length === 0) {
    throw new GatewayError('INTERNAL_ERROR', 'Resolved request context has no tenant.');
  }
  return context.tenantId;
}

export function createJobService(options: JobServiceOptions): JobService {
  const waitDefaultMs = options.waitDefaultMs ?? DEFAULT_WAIT_MS;
  const waitMaxMs = options.waitMaxMs ?? DEFAULT_WAIT_MAX_MS;
  const pollMs = options.waitPollMs ?? DEFAULT_POLL_MS;

  const withFreshAssets = async (job: GenerationJob, context: RequestContext): Promise<GenerationJob> => {
    if (options.assets === undefined || job.assets.length === 0) return job;
    const assets = await options.assets.refresh(job, context);
    return { ...job, assets };
  };

  const loadJob = async (id: string, context: RequestContext): Promise<GenerationJob> => {
    const tenantId = requireTenant(context);
    const job = await options.repository.transaction((tx) => tx.getJob(tenantId, id));
    if (job === undefined) {
      // No ownership disclosure: a foreign job id is indistinguishable from a missing one.
      throw new GatewayError('JOB_NOT_FOUND', `Job ${id} was not found.`, { details: { job_id: id } });
    }
    return withFreshAssets(job, context);
  };

  const cancelPending = async (job: GenerationJob, context: RequestContext): Promise<GenerationJob> => {
    const tenantId = requireTenant(context);
    const now = options.clock.now().toISOString();
    return options.repository.transaction(async (tx) => {
      const envelope = await tx.getSubmission(tenantId, job.id);
      if (envelope === undefined) {
        throw new GatewayError('INTERNAL_ERROR', `Submission record for job ${job.id} was missing.`);
      }
      if (envelope.state === 'cancelled') return (await tx.getJob(tenantId, job.id)) ?? job;
      const released = await tx.updateJob(
        tenantId,
        job.id,
        { status: 'cancelled', updatedAt: now, metadata: { ...job.metadata, cancellation: 'before_submission' } },
        { expectStatus: ['queued'] }
      );
      await tx.updateSubmission(tenantId, job.id, {
        state: 'cancelled',
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
        lastError: { code: 'CANCELLED', message: 'Cancelled before provider submission.', retryable: false }
      });
      await tx.releaseUsage(job.id, now);
      await tx.appendUsageEvent({
        id: `${job.id}:release`,
        tenantId,
        jobId: job.id,
        kind: 'release',
        microUsd: 0,
        at: now
      });
      return released ?? job;
    });
  };

  return {
    get(id, context) {
      return loadJob(id, context);
    },

    async wait(id, timeoutMs, context) {
      // An explicit 0 means "read the current state and return"; only an absent or
      // non-finite value falls back to the default budget.
      if (timeoutMs === 0) return loadJob(id, context);
      const requested = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : waitDefaultMs;
      const budget = Math.min(requested, waitMaxMs);
      const startedAt = Date.now();
      let job = await loadJob(id, context);
      while (!TERMINAL_STATUSES.includes(job.status)) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= budget) break;
        await sleep(Math.min(pollMs, budget - elapsed));
        job = await loadJob(id, context);
      }
      return job;
    },

    async cancel(id, context) {
      const job = await loadJob(id, context);
      if (TERMINAL_STATUSES.includes(job.status)) return job;
      const tenantId = requireTenant(context);
      const envelope = await options.repository.transaction((tx) => tx.getSubmission(tenantId, id));
      if (envelope === undefined || envelope.state === 'pending') {
        return cancelPending(job, context);
      }
      if (envelope.providerJobId === undefined) {
        // A POST is in flight or ambiguous: refusing to report a false cancellation.
        return options.repository.transaction(async (tx) => {
          const updated = await tx.updateJob(
            tenantId,
            id,
            { updatedAt: options.clock.now().toISOString(), metadata: { ...job.metadata, cancellation_rejected: 'submission_in_flight' } },
            { expectStatus: ['queued', 'processing'] }
          );
          return updated ?? job;
        });
      }
      const provider = await options.providerFactory.forContext(context);
      const outcome = await provider.cancelJob(envelope.providerJobId);
      const now = options.clock.now().toISOString();
      if (outcome.accepted) {
        return options.repository.transaction(async (tx) => {
          const updated = await tx.updateJob(
            tenantId,
            id,
            {
              status: 'cancelled',
              updatedAt: now,
              metadata: { ...job.metadata, cancellation: 'accepted', cancellation_pending_reconcile: true }
            },
            { expectStatus: ['queued', 'processing'] }
          );
          await tx.appendUsageEvent({ id: `${id}:release`, tenantId, jobId: id, kind: 'release', microUsd: 0, at: now });
          return updated ?? job;
        });
      }
      return options.repository.transaction(async (tx) => {
        const updated = await tx.updateJob(
          tenantId,
          id,
          { updatedAt: now, metadata: { ...job.metadata, cancellation_rejected: outcome.reason } },
          { expectStatus: ['queued', 'processing'] }
        );
        return updated ?? job;
      });
    },

    async list(context, cursor): Promise<JobListResult> {
      const tenantId = requireTenant(context);
      const result = await options.repository.transaction((tx) =>
        tx.listJobs(tenantId, {
          limit: LIST_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
          ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId })
        })
      );
      const jobs = await Promise.all(result.jobs.map((job) => withFreshAssets(job, context)));
      if (result.nextCursor !== undefined) {
        return { jobs, next_cursor: result.nextCursor };
      }
      return { jobs };
    }
  };
}
