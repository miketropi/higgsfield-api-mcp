import type {
  GenerationJob,
  GenerationRequest,
  MediaAsset,
  RequestContext,
  GenerationResult,
  GenerationService,
  JobRepository,
  JobService,
  MediaService,
  MetricsPort,
  ModelRegistry,
  RateLimiter,
  SubmissionWorker,
  WebhookPlan
} from '@higgsfield-mcp/core';
import {
  isConfirmationRequired,
  createConfirmationStore,
  createCostGuard,
  createGenerationService,
  createJobService,
  createMemoryJobRepository,
  createMemoryRateLimiter,
  createModelRegistry,
  createSubmissionWorker
} from '@higgsfield-mcp/core';
import { TEST_CATALOG, createFakeMediaService, createFakeProvider, createSilentLogger, createNullMetrics } from './fakes.js';
import type { FakeProvider, FakeProviderOptions, RecordingLogger } from './fakes.js';

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
  set(at: Date): void;
}

export interface TestStack {
  clock: TestClock;
  repository: JobRepository;
  registry: ModelRegistry;
  provider: FakeProvider;
  media: MediaService;
  jobs: JobService;
  generation: GenerationService;
  worker: SubmissionWorker;
  metrics: MetricsPort;
  logger: RecordingLogger;
}

export interface TestStackOptions {
  repository?: JobRepository | undefined;
  mediaService?: MediaService | undefined;
  webhook?: WebhookPlan | undefined;
  provider?: FakeProviderOptions | undefined;
  cost?: { maxJobCostUsd?: number; dailyCostLimitUsd?: number; requireConfirmAboveUsd?: number } | undefined;
  media?: MediaService | undefined;
  aliases?: Record<string, string> | undefined;
  now?: Date | undefined;
  worker?: { maxPerClass?: { image: number; video: number; other: number } } | undefined;
  jobsAssets?: { refresh(job: GenerationJob, context: RequestContext): Promise<MediaAsset[]> } | undefined;
}

export function createTestStack(options: TestStackOptions = {}): TestStack {
  const repository = options.repository ?? createMemoryJobRepository();
  const registry = createModelRegistry({
    models: TEST_CATALOG,
    ...(options.aliases === undefined ? {} : { aliases: options.aliases })
  });
  const provider = createFakeProvider(options.provider);
  const media = options.media ?? createFakeMediaService();
  const logger = createSilentLogger();
  const metrics = createNullMetrics();
  let current = options.now ?? new Date();
  const clock: TestClock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(at: Date) {
      current = at;
    }
  };
  const providerFactory = {
    providerId: 'higgsfield',
    async forContext() {
      return provider;
    }
  };
  const costGuard = createCostGuard({
    providerFactory,
    clock,
    logger,
    thresholds: {
      maxJobMicroUsd: options.cost?.maxJobCostUsd === undefined ? undefined : Math.round(options.cost.maxJobCostUsd * 1_000_000),
      dailyLimitMicroUsd:
        options.cost?.dailyCostLimitUsd === undefined ? undefined : Math.round(options.cost.dailyCostLimitUsd * 1_000_000),
      confirmAboveMicroUsd:
        options.cost?.requireConfirmAboveUsd === undefined
          ? undefined
          : Math.round(options.cost.requireConfirmAboveUsd * 1_000_000)
    }
  });
  const confirmation = createConfirmationStore({ repository, clock });
  const jobs = createJobService({
    repository,
    providerFactory,
    clock,
    logger,
    waitPollMs: 5,
    ...(options.jobsAssets === undefined ? {} : { assets: options.jobsAssets })
  });
  const generation = createGenerationService({
    repository,
    registry,
    providerFactory,
    media,
    costGuard,
    confirmation,
    jobs,
    clock,
    logger,
    metrics,
    wait: { defaultMs: 200, maxMs: 25_000 },
    ...(options.webhook === undefined ? {} : { webhook: options.webhook })
  });
  const worker = createSubmissionWorker({
    repository,
    providerFactory,
    clock,
    logger,
    metrics,
    maxPerClass: options.worker?.maxPerClass ?? { image: 10, video: 3, other: 1 },
    pollFloorMs: 1,
    pollCeilingMs: 2,
    replayMinMs: 1,
    replayMaxMs: 2,
    transientBackoffMs: 5,
    random: () => 0.5
  });
  return { clock, repository, registry, provider, media, jobs, generation, worker, metrics, logger };
}

export function createTestRateLimiter(): RateLimiter {
  return createMemoryRateLimiter();
}

/** Narrowing helper: fails loudly when a submission unexpectedly requires confirmation. */
export function expectJob(result: GenerationResult): GenerationJob {
  if (isConfirmationRequired(result)) throw new Error('unexpected confirmation_required result');
  return result;
}

export async function submitJob(
  stack: TestStack,
  tool: string,
  request: GenerationRequest,
  tenantId = 'tenant-a'
): Promise<GenerationJob> {
  return expectJob(await stack.generation.submit(tool, request, { requestId: 'req_test', tenantId, transport: 'stdio' }));
}
