import type {
  GatewayCapabilitiesInfo,
  McpToolDependencies
} from '@higgsfield-mcp/mcp';
import type {
  GenerationService,
  JobRepository,
  JobService,
  MediaService,
  MetricsPort,
  ModelRegistry,
  RequestContext,
  SubmissionWorker
} from '@higgsfield-mcp/core';
import {
  GatewayError,
  createAdmission,
  createMemoryRateLimiter,
  createConfirmationStore,
  createCostGuard,
  createGenerationService,
  createJobService,
  createMemoryJobRepository,
  createModelRegistry,
  createSubmissionWorker
} from '@higgsfield-mcp/core';
import { TEST_CATALOG, createFakeMediaService, createFakeProvider, createNullMetrics, createSilentLogger } from '../../fixtures/fakes.js';
import type { FakeProvider, FakeProviderOptions, RecordingLogger } from '../../fixtures/fakes.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export interface TestMetrics extends MetricsPort {
  render(): Promise<string>;
  readonly contentType: string;
}

export interface TestDepsOptions {
  provider?: FakeProviderOptions | undefined;
  localFileAccess?: boolean | undefined;
}

export interface TestDeps {
  repository: JobRepository;
  registry: ModelRegistry;
  provider: FakeProvider;
  media: MediaService;
  jobs: JobService;
  generation: GenerationService;
  worker: SubmissionWorker;
  metrics: TestMetrics;
  logger: RecordingLogger;
  deps: McpToolDependencies;
  capabilities: GatewayCapabilitiesInfo;
}

/**
 * Fully in-memory gateway service graph used by integration and protocol tests.
 * Local file inputs are refused unless `localFileAccess` is set, mirroring the
 * documented stdio-versus-HTTP rule enforced by the media service.
 */
export function createTestDeps(options: TestDepsOptions = {}): TestDeps {
  const repository = createMemoryJobRepository();
  const registry = createModelRegistry({ models: TEST_CATALOG });
  const provider = createFakeProvider(options.provider);
  const logger = createSilentLogger();
  const metrics: TestMetrics = {
    ...createNullMetrics(),
    async render() {
      return '';
    },
    contentType: 'text/plain; version=0.0.4'
  };
  const clock = { now: () => new Date() };
  const providerFactory = {
    providerId: 'higgsfield',
    async forContext() {
      return provider;
    }
  };
  const assetOwner = new Map<string, string>();
  const localFileAccess = options.localFileAccess ?? false;
  const media = createFakeMediaService({
    async upload(input) {
      if ('path' in input.source && !localFileAccess) {
        throw new GatewayError('INVALID_INPUT', 'Local file inputs are not accepted over this transport.');
      }
      assetOwner.set('asset_uploaded', 'tenant-a');
      return {
        id: 'asset_uploaded',
        tenantId: 'tenant-a',
        provider: 'higgsfield',
        mediaType: input.mediaType ?? 'image',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        url: 'https://cdn.example.com/uploaded.png',
        createdAt: new Date().toISOString(),
        origin: 'upload',
        storageKey: 'uploads/a'
      };
    },
    async get(id, context) {
      if (assetOwner.get(id) !== context.tenantId) {
        throw new GatewayError('ACCESS_DENIED', 'Asset not found for this tenant.');
      }
      return {
        id,
        tenantId: context.tenantId as string,
        provider: 'higgsfield',
        mediaType: 'image',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        url: 'https://cdn.example.com/uploaded.png',
        createdAt: new Date().toISOString(),
        origin: 'upload'
      };
    },
    async resolve(reference) {
      if (reference.type === 'file' && !localFileAccess) {
        throw new GatewayError('INVALID_INPUT', 'Local file inputs are not accepted over this transport.');
      }
      return createFakeMediaService().resolve(reference, storeContext());
    },
    async identify(reference) {
      if (reference.type === 'file' && !localFileAccess) {
        throw new GatewayError('INVALID_INPUT', 'Local file inputs are not accepted over this transport.');
      }
      return createFakeMediaService().identify(reference, storeContext());
    }
  });
  const costGuard = createCostGuard({ providerFactory, clock, logger, thresholds: {} });
  const confirmation = createConfirmationStore({ repository, clock });
  const jobs = createJobService({ repository, providerFactory, clock, logger, waitPollMs: 5 });
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
    wait: { defaultMs: 200, maxMs: 25_000 }
  });
  const worker = createSubmissionWorker({
    repository,
    providerFactory,
    clock,
    logger,
    metrics,
    maxPerClass: { image: 2, video: 1, other: 1 },
    pollFloorMs: 5,
    pollCeilingMs: 10,
    replayMinMs: 5,
    replayMaxMs: 10,
    random: () => 0.5
  });
  const capabilities: GatewayCapabilitiesInfo = {
    gatewayVersion: '0.1.0-test',
    mcpProtocol: '2026-07-28',
    provider: { id: 'higgsfield', version: provider.version },
    skillsVersion: 'unavailable',
    capabilities: ['image_generation', 'image_edit', 'text_to_video', 'image_to_video', 'reference_to_video'],
    auth: { mode: 'none', scopes: ['higgsfield:read', 'higgsfield:generate', 'higgsfield:upload'] },
    limits: { maxWaitMs: 25_000, maxImageJobs: 2, maxVideoJobs: 1 }
  };
  const admission = createAdmission({
    limiter: createMemoryRateLimiter({ clock }),
    rules: {
      global: { limit: 1_000, windowMs: 60_000 },
      perClass: {
        image: { limit: 1_000, windowMs: 60_000 },
        video: { limit: 1_000, windowMs: 60_000 },
        other: { limit: 1_000, windowMs: 60_000 },
        upload: { limit: 1_000, windowMs: 60_000 },
        read: { limit: 1_000, windowMs: 60_000 }
      }
    },
    logger,
    failClosed: false
  });
  const deps: McpToolDependencies = {
    generation,
    jobs,
    media,
    models: registry,
    capabilities,
    admission,
    logger,
    metrics
  };
  return {
    repository,
    registry,
    provider,
    media,
    jobs,
    generation,
    worker,
    metrics,
    logger,
    deps,
    capabilities
  };
}

function storeContext(): RequestContext {
  return {
    requestId: 'req_store',
    tenantId: 'tenant-a',
    transport: 'stdio',
    auth: { tenantId: 'tenant-a', mode: 'stdio', scopes: ['higgsfield:read'] }
  };
}

export function stdioContext(): RequestContext {
  return {
    requestId: 'req_stdio',
    tenantId: 'local',
    transport: 'stdio',
    auth: { tenantId: 'local', mode: 'stdio', scopes: ['higgsfield:read', 'higgsfield:generate', 'higgsfield:upload'] }
  };
}
