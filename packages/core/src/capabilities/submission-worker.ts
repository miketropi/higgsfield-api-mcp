import type {
  Clock,
  ConcurrencyClass,
  GenerationJob,
  LoggerPort,
  MediaAsset,
  MetricsPort,
  ProviderAssetRef,
  ProviderFactory,
  ProviderJobSnapshot,
  ProviderSubmissionPlan,
  RequestContext,
  StructuredError
} from '../contracts.js';
import { toStructuredError } from '../errors.js';
import { newId } from '../ids.js';
import type { JobRepository, SubmissionEnvelope } from '../jobs/repository.js';
import type { SubmissionState } from '../contracts.js';
import { TERMINAL_STATUSES } from '../jobs/service.js';
import { createAssetFromProviderRef } from './assets.js';

export interface WorkerTickResult {
  claimed: number;
  submitted: number;
  replayScheduled: number;
  unknownOutcome: number;
  rejected: number;
  polled: number;
  completed: number;
}

export interface SubmissionWorkerOptions {
  repository: JobRepository;
  providerFactory: ProviderFactory;
  clock: Clock;
  logger: LoggerPort;
  metrics: MetricsPort;
  maxPerClass: Record<ConcurrencyClass, number>;
  owner?: string | undefined;
  leaseTtlMs?: number | undefined;
  batchLimit?: number | undefined;
  pollBatchLimit?: number | undefined;
  pollFloorMs?: number | undefined;
  pollCeilingMs?: number | undefined;
  transientBackoffMs?: number | undefined;
  replayMinMs?: number | undefined;
  replayMaxMs?: number | undefined;
  random?: (() => number) | undefined;
  materializeAssets?:
    | ((refs: ProviderAssetRef[], job: GenerationJob) => Promise<MediaAsset[]>)
    | undefined;
}

export interface SubmissionWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<WorkerTickResult>;
  reconcileOnStartup(): Promise<{ polled: number; completed: number }>;
  /**
   * Clears the backoff for one job so the next tick polls it. Used by the webhook
   * hint path: a hint never changes status by itself.
   */
  nudge(jobId: string): void;
}

interface PollState {
  nextAt: number;
  intervalMs: number;
  failures: number;
}

const DEFAULTS = {
  leaseTtlMs: 60_000,
  batchLimit: 10,
  pollBatchLimit: 50,
  pollFloorMs: 2_000,
  pollCeilingMs: 10_000,
  transientBackoffMs: 60_000,
  replayMinMs: 2_000,
  replayMaxMs: 60_000
} as const;

function activeJobCount(result: WorkerTickResult): number {
  return result.submitted + result.replayScheduled;
}

export function createSubmissionWorker(options: SubmissionWorkerOptions): SubmissionWorker {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULTS.leaseTtlMs;
  const batchLimit = options.batchLimit ?? DEFAULTS.batchLimit;
  const pollBatchLimit = options.pollBatchLimit ?? DEFAULTS.pollBatchLimit;
  const pollFloorMs = options.pollFloorMs ?? DEFAULTS.pollFloorMs;
  const pollCeilingMs = options.pollCeilingMs ?? DEFAULTS.pollCeilingMs;
  const transientBackoffMs = options.transientBackoffMs ?? DEFAULTS.transientBackoffMs;
  const replayMinMs = options.replayMinMs ?? DEFAULTS.replayMinMs;
  const replayMaxMs = options.replayMaxMs ?? DEFAULTS.replayMaxMs;
  const random = options.random ?? Math.random;
  const owner = options.owner ?? `worker_${newId('req').slice(4)}`;
  const pollState = new Map<string, PollState>();
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;

  const jittered = (baseMs: number): number => Math.round(baseMs * (0.8 + random() * 0.4));

  const workerContext = (tenantId: string): RequestContext => ({
    requestId: newId('req'),
    tenantId,
    transport: 'stdio'
  });

  const materialize = async (refs: ProviderAssetRef[], job: GenerationJob): Promise<MediaAsset[]> => {
    if (options.materializeAssets !== undefined) return options.materializeAssets(refs, job);
    return refs.map((ref) =>
      createAssetFromProviderRef(ref, {
        tenantId: job.tenantId,
        provider: job.provider,
        jobId: job.id,
        createdAt: options.clock.now().toISOString(),
        ...(job.workspaceId === undefined ? {} : { workspaceId: job.workspaceId })
      })
    );
  };

  const submissionPatch = (state: SubmissionState): { submissionState: SubmissionState } => ({ submissionState: state });

  const snapshotError = (snapshot: ProviderJobSnapshot): StructuredError => {
    if (snapshot.error !== undefined) return snapshot.error;
    return { code: 'JOB_FAILED', message: 'Provider reported a failed request.', retryable: false };
  };

  const applyTerminal = async (job: GenerationJob, snapshot: ProviderJobSnapshot): Promise<boolean> => {
    const nowIso = options.clock.now().toISOString();
    const assets = await materialize(snapshot.assets, job);
    const durationSeconds = Math.max(0, (Date.parse(nowIso) - Date.parse(job.createdAt)) / 1000);
    const estimated = snapshot.cost?.estimatedMicroUsd ?? job.cost?.estimatedMicroUsd;
    const actual = snapshot.cost?.actualMicroUsd;
    const cost =
      estimated === undefined && actual === undefined
        ? undefined
        : {
            currency: 'USD' as const,
            source: snapshot.cost?.source ?? job.cost?.source ?? ('unavailable' as const),
            ...(estimated === undefined ? {} : { estimatedMicroUsd: estimated }),
            ...(actual === undefined ? {} : { actualMicroUsd: actual })
          };
    const updated = await options.repository.transaction(async (tx) => {
      const patched = await tx.updateJob(
        job.tenantId,
        job.id,
        {
          status: snapshot.status,
          updatedAt: nowIso,
          assets,
          ...(snapshot.progress === undefined ? {} : { progress: snapshot.progress }),
          ...(snapshot.status === 'failed' ? { error: snapshotError(snapshot) } : {}),
          ...(snapshot.metadata === undefined
            ? {}
            : { metadata: { ...job.metadata, ...snapshot.metadata } }),
          ...(cost === undefined ? {} : { cost })
        },
        { expectStatus: ['queued', 'processing', 'cancelled'] }
      );
      if (patched === undefined) return undefined;
      for (const asset of assets) await tx.insertAsset(asset);
      if (snapshot.status === 'completed') {
        const settled = actual ?? estimated ?? 0;
        await tx.settleUsage(job.id, settled, nowIso);
        await tx.appendUsageEvent({
          id: `${job.id}:settle`,
          tenantId: job.tenantId,
          jobId: job.id,
          kind: 'settle',
          microUsd: settled,
          at: nowIso
        });
      } else {
        await tx.releaseUsage(job.id, nowIso);
        await tx.appendUsageEvent({
          id: `${job.id}:release`,
          tenantId: job.tenantId,
          jobId: job.id,
          kind: 'release',
          microUsd: 0,
          at: nowIso
        });
      }
      return patched;
    });
    if (updated === undefined) return false;
    pollState.delete(job.id);
    options.metrics.activeJobs(job.concurrencyClass, -1);
    options.metrics.jobFinished(
      job.provider,
      job.capability,
      job.kind,
      snapshot.status,
      durationSeconds
    );
    options.logger.info(
      { event: 'generation.completed', job_id: job.id, status: snapshot.status, duration_ms: durationSeconds * 1000 },
      'Generation job reached a terminal state'
    );
    return true;
  };

  const pollJob = async (job: GenerationJob): Promise<boolean> => {
    const envelope = await options.repository.transaction((tx) => tx.getSubmission(job.tenantId, job.id));
    if (envelope === undefined || envelope.providerJobId === undefined) return false;
    if (envelope.state !== 'acknowledged') {
      options.logger.warn(
        { event: 'generation.poll_skipped', job_id: job.id, submission_state: envelope.state },
        'Skipping poll for a submission that is not acknowledged'
      );
      return false;
    }
    const state = pollState.get(job.id) ?? { nextAt: 0, intervalMs: pollFloorMs, failures: 0 };
    const nowMs = options.clock.now().getTime();
    if (state.nextAt > nowMs) return false;
    try {
      const provider = await options.providerFactory.forContext(workerContext(job.tenantId));
      const snapshot = await provider.getJob(envelope.providerJobId);
      options.metrics.providerRequest(provider.id, 'status', 'ok');
      if (TERMINAL_STATUSES.includes(snapshot.status)) {
        return applyTerminal(job, snapshot);
      }
      await options.repository.transaction((tx) =>
        tx.updateJob(
          job.tenantId,
          job.id,
          {
            status: snapshot.status,
            updatedAt: options.clock.now().toISOString(),
            ...(snapshot.progress === undefined ? {} : { progress: snapshot.progress }),
            ...(snapshot.metadata === undefined ? {} : { metadata: { ...job.metadata, ...snapshot.metadata } })
          },
          { expectStatus: ['queued', 'processing'] }
        )
      );
      const next = Math.min(
        pollCeilingMs,
        Math.max(pollFloorMs, state.intervalMs === 0 ? pollFloorMs : state.intervalMs * 1.5)
      );
      pollState.set(job.id, { nextAt: options.clock.now().getTime() + jittered(next), intervalMs: next, failures: 0 });
      return false;
    } catch (error) {
      const structured = toStructuredError(error);
      options.metrics.providerError('higgsfield', structured.code);
      const failures = state.failures + 1;
      const backoff = structured.retryAfterMs ?? Math.min(transientBackoffMs, pollFloorMs * 2 ** failures);
      pollState.set(job.id, { nextAt: options.clock.now().getTime() + jittered(backoff), intervalMs: state.intervalMs, failures });
      options.logger.warn(
        { event: 'generation.poll_failed', job_id: job.id, code: structured.code, failures },
        'Transient provider poll failure; the job stays non-terminal'
      );
      return false;
    }
  };

  const submitEnvelope = async (
    envelope: SubmissionEnvelope,
    result: WorkerTickResult
  ): Promise<void> => {
    const job = await options.repository.transaction((tx) => tx.getJob(envelope.tenantId, envelope.jobId));
    if (job === undefined) {
      await options.repository.transaction((tx) => tx.releaseLease(envelope.jobId, owner));
      return;
    }
    if (job.status === 'cancelled' || envelope.state === 'cancelled') {
      await options.repository.transaction(async (tx) => {
        await tx.updateSubmission(envelope.tenantId, envelope.jobId, {
          state: 'cancelled',
          leaseOwner: undefined,
          leaseExpiresAt: undefined
        });
      });
      return;
    }
    const provider = await options.providerFactory.forContext(workerContext(envelope.tenantId));
    const plan: ProviderSubmissionPlan = {
      endpoint: envelope.endpoint,
      body: envelope.body,
      bodyHash: envelope.bodyHash,
      jobKind: envelope.jobKind,
      ...(envelope.query === undefined ? {} : { query: envelope.query }),
      ...(envelope.webhookUrl === undefined ? {} : { webhook: { url: envelope.webhookUrl } })
    };
    const nowIso = options.clock.now().toISOString();
    try {
      const snapshot = await provider.submit(plan, { upstreamIdempotencyKey: envelope.upstreamIdempotencyKey });
      options.metrics.providerRequest(provider.id, 'submit', 'ok');
      await options.repository.transaction(async (tx) => {
        await tx.updateSubmission(envelope.tenantId, envelope.jobId, {
          state: 'acknowledged',
          providerJobId: snapshot.providerJobId,
          attempts: envelope.attempts + 1,
          lastAttemptAt: nowIso,
          nextAttemptAt: undefined,
          leaseOwner: undefined,
          leaseExpiresAt: undefined
        });
        await tx.updateJob(
          envelope.tenantId,
          envelope.jobId,
          {
            status: snapshot.status,
            providerJobId: snapshot.providerJobId,
            updatedAt: nowIso,
            ...submissionPatch('acknowledged'),
            ...(snapshot.metadata === undefined ? {} : { metadata: { ...job.metadata, ...snapshot.metadata } })
          },
          { expectStatus: ['queued', 'processing'] }
        );
      });
      options.metrics.queuedJobs(envelope.concurrencyClass, -1);
      options.metrics.activeJobs(envelope.concurrencyClass, 1);
      options.metrics.jobStarted(provider.id, job.capability, job.kind);
      result.submitted += 1;
      if (TERMINAL_STATUSES.includes(snapshot.status)) {
        await applyTerminal({ ...job, providerJobId: snapshot.providerJobId }, snapshot);
      }
    } catch (error) {
      options.metrics.providerRequest(provider.id, 'submit', 'error');
      const structured = toStructuredError(error);
      options.metrics.providerError(provider.id, structured.code);
      // The kind is essential: an ambiguous Soul-training POST has no documented
      // idempotency guarantee and must never be replayed automatically.
      const replayable = provider.getIdempotencySupport?.(envelope.jobKind) === 'documented';
      if (structured.retryable === true && replayable) {
        const attempts = envelope.attempts + 1;
        const backoff = Math.min(replayMaxMs, replayMinMs * 2 ** Math.min(attempts - 1, 6));
        await options.repository.transaction((tx) =>
          tx.updateSubmission(envelope.tenantId, envelope.jobId, {
            state: 'submitting',
            attempts,
            lastAttemptAt: nowIso,
            nextAttemptAt: new Date(options.clock.now().getTime() + jittered(backoff)).toISOString(),
            lastError: structured,
            leaseOwner: undefined,
            leaseExpiresAt: undefined
          })
        );
        await options.repository.transaction((tx) =>
          tx.updateJob(
            envelope.tenantId,
            envelope.jobId,
            { updatedAt: nowIso, ...submissionPatch('submitting') },
            { expectStatus: ['queued', 'processing'] }
          )
        );
        result.replayScheduled += 1;
        options.logger.warn(
          { event: 'generation.submit_retry', job_id: envelope.jobId, code: structured.code, attempts },
          'Ambiguous provider submission; replaying the identical request and key'
        );
        return;
      }
      if (structured.retryable === true && !replayable) {
        await options.repository.transaction(async (tx) => {
          await tx.updateSubmission(envelope.tenantId, envelope.jobId, {
            state: 'outcome_unknown',
            attempts: envelope.attempts + 1,
            lastAttemptAt: nowIso,
            lastError: structured,
            leaseOwner: undefined,
            leaseExpiresAt: undefined
          });
          await tx.updateJob(
            envelope.tenantId,
            envelope.jobId,
            {
              status: 'processing',
              updatedAt: nowIso,
              ...submissionPatch('outcome_unknown'),
              metadata: { ...job.metadata, submission_outcome: 'unknown' },
              error: {
                code: 'PROVIDER_ERROR',
                message:
                  'Provider submission outcome is unknown and this endpoint publishes no idempotency guarantee; it is never replayed automatically.',
                retryable: false
              }
            },
            { expectStatus: ['queued', 'processing'] }
          );
        });
        result.unknownOutcome += 1;
        options.logger.error(
          { event: 'generation.submission_outcome_unknown', job_id: envelope.jobId, code: structured.code },
          'Provider submission outcome unknown; operator reconciliation required'
        );
        return;
      }
      await options.repository.transaction(async (tx) => {
        await tx.updateSubmission(envelope.tenantId, envelope.jobId, {
          state: 'rejected',
          attempts: envelope.attempts + 1,
          lastAttemptAt: nowIso,
          lastError: structured,
          leaseOwner: undefined,
          leaseExpiresAt: undefined
        });
        await tx.updateJob(
          envelope.tenantId,
          envelope.jobId,
          { status: 'failed', updatedAt: nowIso, error: structured, ...submissionPatch('rejected') },
          { expectStatus: ['queued', 'processing'] }
        );
        await tx.releaseUsage(envelope.jobId, nowIso);
        await tx.appendUsageEvent({
          id: `${envelope.jobId}:release`,
          tenantId: envelope.tenantId,
          jobId: envelope.jobId,
          kind: 'release',
          microUsd: 0,
          at: nowIso
        });
      });
      options.metrics.queuedJobs(envelope.concurrencyClass, -1);
      result.rejected += 1;
      options.logger.warn(
        { event: 'generation.submit_rejected', job_id: envelope.jobId, code: structured.code },
        'Provider refused the submission before acceptance'
      );
    }
  };

  const pollReconcilable = async (result: WorkerTickResult): Promise<void> => {
    const jobs = await options.repository.transaction((tx) => tx.listReconcilableJobs(pollBatchLimit));
    for (const job of jobs) {
      const applied = await pollJob(job);
      result.polled += 1;
      if (applied) result.completed += 1;
    }
  };

  const runOnce = async (): Promise<WorkerTickResult> => {
    const result: WorkerTickResult = {
      claimed: 0,
      submitted: 0,
      replayScheduled: 0,
      unknownOutcome: 0,
      rejected: 0,
      polled: 0,
      completed: 0
    };
    const nowIso = options.clock.now().toISOString();
    const claimed = await options.repository.transaction((tx) =>
      tx.claimSubmissions({
        owner,
        leaseTtlMs,
        now: nowIso,
        batchLimit,
        maxPerClass: options.maxPerClass
      })
    );
    result.claimed = claimed.length;
    for (const envelope of claimed) {
      await submitEnvelope(envelope, result);
    }
    await pollReconcilable(result);
    if (activeJobCount(result) === 0 && result.polled === 0) {
      options.logger.debug({ event: 'worker.idle' }, 'Worker tick found no work');
    }
    return result;
  };

  return {
    async runOnce() {
      if (ticking) {
        return {
          claimed: 0,
          submitted: 0,
          replayScheduled: 0,
          unknownOutcome: 0,
          rejected: 0,
          polled: 0,
          completed: 0
        };
      }
      ticking = true;
      try {
        return await runOnce();
      } finally {
        ticking = false;
      }
    },

    nudge(jobId: string) {
      pollState.delete(jobId);
      void runOnce().catch((error: unknown) => {
        const structured = toStructuredError(error);
        options.logger.warn(
          { event: 'worker.nudge_failed', job_id: jobId, code: structured.code },
          'Nudged reconciliation failed; the regular loop continues'
        );
      });
    },

    async reconcileOnStartup() {
      const result: WorkerTickResult = {
        claimed: 0,
        submitted: 0,
        replayScheduled: 0,
        unknownOutcome: 0,
        rejected: 0,
        polled: 0,
        completed: 0
      };
      await pollReconcilable(result);
      options.logger.info(
        { event: 'worker.reconciled', polled: result.polled, completed: result.completed },
        'Reconciled non-terminal jobs on startup'
      );
      return { polled: result.polled, completed: result.completed };
    },

    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void this.runOnce().catch((error: unknown) => {
          const structured = toStructuredError(error);
          options.logger.error(
            { event: 'worker.tick_failed', code: structured.code },
            'Worker tick failed; the loop continues'
          );
        });
      }, pollFloorMs);
      timer.unref?.();
    },

    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      while (ticking) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 25);
        await promise;
      }
    }
  };
}
