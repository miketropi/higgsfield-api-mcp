import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AuthContext,
  Clock,
  SubmissionWorker,
  CredentialResolver,
  GenerationService,
  JobRepository,
  JobService,
  LoggerPort,
  MediaService,
  ModelRegistry,
  ObjectStore,
  ProviderFactory,
  RateLimiter,
  RequestContext
} from '@higgsfield-mcp/core';
import {
  createAdmission,
  type AdmissionRules,
  createProviderAssetMaterializer,
  createConfirmationStore,
  createCostGuard,
  createGenerationService,
  createJobService,
  createMemoryJobRepository,
  createMemoryRateLimiter,
  createModelRegistry,
  createPostgresJobRepository,
  createRedisRateLimiter,
  createS3ObjectStore,
  createSubmissionWorker,
  GatewayError,
  parseEncryptionKey,
  runMigrations,
  usdToMicroUsd,
  createMediaService
} from '@higgsfield-mcp/core';
import type { GatewayConfig, ModelAliasesFile, RateLimitsFile, TenantRecord } from '@higgsfield-mcp/config';
import { loadModelAliasesFile, loadRateLimitsFile, loadTenantsFile } from '@higgsfield-mcp/config';
import { createLogger, createMetrics, initTracing, type GatewayMetrics, type TracingHandle } from '@higgsfield-mcp/observability';
import {
  createHiggsfieldProviderFactory,
  HIGGSFIELD_ADAPTER_VERSION,
  HIGGSFIELD_PROVIDER_ID,
  loadBundledCatalog
} from '@higgsfield-mcp/provider-higgsfield';
import type { GatewayCapabilitiesInfo, McpToolDependencies } from '@higgsfield-mcp/mcp';
import { createAuthService, httpRequestContext, type AuthService } from './auth.js';
import { createCredentialResolver } from './tenants.js';
import { resolveSkillsDir } from './skills-dir.js';
import { GATEWAY_VERSION, MCP_PROTOCOL_REVISION } from './version.js';

export interface GatewayContainer {
  config: GatewayConfig;
  logger: LoggerPort;
  metrics: GatewayMetrics;
  repository: JobRepository;
  rateLimiter: RateLimiter;
  registry: ModelRegistry;
  providerFactory: ProviderFactory;
  credentials: CredentialResolver;
  media: MediaService;
  generation: GenerationService;
  jobs: JobService;
  worker: SubmissionWorker;
  auth: AuthService;
  mcpDeps: McpToolDependencies;
  tenants: TenantRecord[];
  rateLimits: RateLimitsFile | undefined;
  readiness: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  stopAdmission: () => Promise<void>;
  shutdown: () => Promise<void>;
}

const clock: Clock = { now: () => new Date() };

function defaultCapabilityList(registry: ModelRegistry): string[] {
  const capabilities = new Set<string>();
  for (const model of registry.list()) {
    for (const capability of model.capabilities) capabilities.add(capability);
  }
  return [...capabilities].sort();
}

function readSkillsVersion(skillsDir: string | undefined): string {
  if (skillsDir === undefined) return 'unavailable';
  try {
    const manifest = JSON.parse(readFileSync(join(skillsDir, 'manifest.json'), 'utf8')) as {
      adapterVersion?: string;
      upstream?: { version?: string };
    };
    const adapter = manifest.adapterVersion ?? 'unknown';
    const upstream = manifest.upstream?.version ?? 'unknown';
    return `${adapter}+upstream.${upstream}`;
  } catch {
    return 'unavailable';
  }
}

function aliasesFromFile(path: string | undefined): { aliases: Record<string, string>; pricing: ModelAliasesFile['pricing'] } {
  if (path === undefined) return { aliases: {}, pricing: undefined };
  const file = loadModelAliasesFile(path);
  return { aliases: file.aliases, pricing: file.pricing };
}

export async function createContainer(
  config: GatewayConfig,
  env: Record<string, string | undefined> = process.env
): Promise<GatewayContainer> {
  const logger = createLogger({
    level: config.observability.level,
    pretty: config.observability.pretty,
    serviceName: config.observability.serviceName
  });
  const metrics = createMetrics({ enabled: config.observability.metricsEnabled, serviceName: config.observability.serviceName });
  let tracing: TracingHandle | undefined;
  if (config.observability.otlpEndpoint !== undefined) {
    const initialized = await initTracing({
      otlpEndpoint: config.observability.otlpEndpoint,
      serviceName: config.observability.serviceName
    });
    tracing = initialized;
  }

  const tenants = config.auth.tenantsFile === undefined ? [] : loadTenantsFile(config.auth.tenantsFile).tenants;
  const rateLimits = config.limits.rateLimitsFile === undefined ? undefined : loadRateLimitsFile(config.limits.rateLimitsFile);
  const { aliases, pricing } = aliasesFromFile(config.models.aliasesFile);
  const encryptionKey =
    config.dataEncryptionKey === undefined ? undefined : parseEncryptionKey(config.dataEncryptionKey);

  const repository =
    config.persistence.databaseUrl === undefined
      ? createMemoryJobRepository()
      : createPostgresJobRepository({
          connectionString: config.persistence.databaseUrl,
          logger,
          ...(encryptionKey === undefined ? {} : { encryptionKey })
        });

  const rateLimiter =
    config.persistence.redisUrl === undefined
      ? createMemoryRateLimiter({ clock })
      : createRedisRateLimiter({ url: config.persistence.redisUrl, logger });

  const credentials = createCredentialResolver({ config, env, tenants, logger });
  const providerFactory = createHiggsfieldProviderFactory({
    credentialResolver: credentials,
    baseUrl: config.provider.baseUrl,
    requestTimeoutMs: config.provider.requestTimeoutMs,
    uploadTimeoutMs: config.provider.uploadTimeoutMs
  });

  const registry = createModelRegistry({
    models: loadBundledCatalog(),
    aliases,
    ...(pricing === undefined ? {} : { pricing })
  });

  let objectStore: ObjectStore | undefined;
  if (config.storage.bucket !== undefined) {
    if (config.storage.accessKeyId === undefined || config.storage.secretAccessKey === undefined) {
      throw new GatewayError('INVALID_INPUT', 'Object storage is configured without credentials.', {
        details: { reason: 'storage_credentials_missing' }
      });
    }
    objectStore = createS3ObjectStore({
      region: config.storage.region,
      bucket: config.storage.bucket,
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
      forcePathStyle: config.storage.forcePathStyle,
      prefix: config.storage.prefix,
      ...(config.storage.endpoint === undefined ? {} : { endpoint: config.storage.endpoint })
    });
  }

  const media = createMediaService({
    repository,
    providerFactory,
    clock,
    logger,
    metrics,
    objectStore,
    config: {
      allowedPaths: config.media.allowedPaths,
      assetMode: config.media.assetMode,
      maxUploadBytes: config.media.maxUploadBytes,
      downloadTimeoutMs: config.media.downloadTimeoutMs,
      maxRedirects: config.media.maxRedirects,
      signedUrlTtlSeconds: config.media.signedUrlTtlSeconds,
      localFileAccess: config.transport === 'stdio'
    }
  });

  const admissionRules: AdmissionRules = {
    global: rateLimits?.global ?? { limit: 120, windowMs: 60_000 },
    perClass: {
      image: rateLimits?.tenant?.default ?? { limit: 30, windowMs: 60_000 },
      video: rateLimits?.tenant?.default ?? { limit: 5, windowMs: 60_000 },
      other: rateLimits?.tenant?.default ?? { limit: 5, windowMs: 60_000 },
      upload: rateLimits?.tenant?.default ?? { limit: 30, windowMs: 60_000 },
      read: rateLimits?.tenant?.default ?? { limit: 120, windowMs: 60_000 }
    },
    ...(rateLimits?.tool?.byName === undefined ? {} : { perTool: rateLimits.tool.byName }),
    ...(rateLimits?.provider?.default === undefined ? {} : { provider: rateLimits.provider.default })
  };
  const admission = createAdmission({
    limiter: rateLimiter,
    rules: admissionRules,
    logger,
    failClosed: config.mode === 'remote'
  });

  const costGuard = createCostGuard({
    providerFactory,
    clock,
    logger,
    thresholds: {
      ...(usdToMicroUsd(config.cost.maxJobCostUsd) === undefined ? {} : { maxJobMicroUsd: usdToMicroUsd(config.cost.maxJobCostUsd) as number }),
      ...(usdToMicroUsd(config.cost.dailyCostLimitUsd) === undefined ? {} : { dailyLimitMicroUsd: usdToMicroUsd(config.cost.dailyCostLimitUsd) as number }),
      ...(usdToMicroUsd(config.cost.requireConfirmAboveUsd) === undefined
        ? {}
        : { confirmAboveMicroUsd: usdToMicroUsd(config.cost.requireConfirmAboveUsd) as number })
    }
  });
  const confirmation = createConfirmationStore({ repository, clock });
  const jobs = createJobService({
    repository,
    providerFactory,
    clock,
    logger,
    waitMaxMs: 25_000,
    waitDefaultMs: 20_000,
    assets: {
      async refresh(job, context) {
        const now = clock.now().toISOString();
        const refreshed = [];
        for (const asset of job.assets) {
          const stale =
            asset.origin === 'managed' || (asset.urlExpiresAt !== undefined && asset.urlExpiresAt <= now);
          if (!stale) {
            refreshed.push(asset);
            continue;
          }
          try {
            refreshed.push(await media.get(asset.id, context));
          } catch {
            refreshed.push(asset);
          }
        }
        return refreshed;
      }
    }
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
    wait: { defaultMs: 20_000, maxMs: 25_000 },
    admission,
    ...(config.features.webhooks && config.server.publicUrl !== undefined
      ? {
          webhook: {
            callbackUrl: (_jobId: string, token: string): string =>
              `${(config.server.publicUrl as string).replace(/\/$/, '')}/webhooks/higgsfield?token=${encodeURIComponent(token)}`,
            ownsUrl: (supplied: string): boolean => {
              try {
                const candidate = new URL(supplied);
                const gateway = new URL(config.server.publicUrl as string);
                return candidate.origin === gateway.origin && candidate.pathname === '/webhooks/higgsfield';
              } catch {
                return false;
              }
            }
          }
        }
      : {})
  });

  const worker = createSubmissionWorker({
    repository,
    providerFactory,
    clock,
    logger,
    metrics,
    maxPerClass: { image: config.limits.maxImageJobs, video: config.limits.maxVideoJobs, other: 1 },
    pollFloorMs: config.workers.pollIntervalFloorMs,
    pollCeilingMs: config.workers.pollIntervalCeilingMs,
    transientBackoffMs: config.workers.transientBackoffMs,
    replayMinMs: config.workers.replayBackoffMinMs,
    replayMaxMs: config.workers.replayBackoffMaxMs,
    materializeAssets: createProviderAssetMaterializer({
      assetMode: config.media.assetMode,
      maxUploadBytes: config.media.maxUploadBytes,
      downloadTimeoutMs: config.media.downloadTimeoutMs,
      maxRedirects: config.media.maxRedirects,
      signedUrlTtlSeconds: config.media.signedUrlTtlSeconds,
      clock,
      logger,
      metrics,
      ...(objectStore === undefined ? {} : { objectStore })
    })
  });

  const capabilities: GatewayCapabilitiesInfo = {
    gatewayVersion: GATEWAY_VERSION,
    mcpProtocol: MCP_PROTOCOL_REVISION,
    provider: { id: HIGGSFIELD_PROVIDER_ID, version: HIGGSFIELD_ADAPTER_VERSION },
    skillsVersion: readSkillsVersion(resolveSkillsDir(config.skillsDir)),
    capabilities: defaultCapabilityList(registry),
    auth: { mode: config.auth.mode, scopes: ['higgsfield:read', 'higgsfield:generate', 'higgsfield:upload'] },
    limits: { maxWaitMs: 25_000, maxImageJobs: config.limits.maxImageJobs, maxVideoJobs: config.limits.maxVideoJobs }
  };

  const mcpDeps: McpToolDependencies = {
    generation,
    jobs,
    media,
    models: registry,
    capabilities,
    admission,
    logger,
    metrics
  };
  const auth = createAuthService({ config, env, tenants, logger });

  const readiness = async (): Promise<{ ok: boolean; checks: Record<string, boolean> }> => {
    const checks: Record<string, boolean> = {};
    const attempt = async (name: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
        checks[name] = true;
      } catch {
        checks[name] = false;
      }
    };
    await attempt('repository', () => repository.health());
    await attempt('rate_limiter', () => rateLimiter.health());
    if (objectStore !== undefined) await attempt('object_storage', () => objectStore.health());
    await attempt('provider_catalog', async () => {
      if (registry.list().length === 0) throw new GatewayError('PROVIDER_ERROR', 'Provider catalog is empty.');
    });
    await attempt('provider_credentials', async () => {
      const context: RequestContext = {
        requestId: 'readiness',
        transport: config.transport,
        ...(tenants[0] === undefined ? {} : { tenantId: tenants[0].tenantId })
      };
      const resolved = await credentials.resolve(context);
      if (resolved.credentials.length === 0) {
        throw new GatewayError('AUTHENTICATION_FAILED', 'Provider credentials are empty.');
      }
    });
    return { ok: Object.values(checks).every(Boolean), checks };
  };

  if (config.workers.enabled) {
    worker.start();
    await worker.reconcileOnStartup();
  }

  return {
    config,
    logger,
    metrics,
    repository,
    rateLimiter,
    registry,
    providerFactory,
    credentials,
    media,
    generation,
    jobs,
    worker,
    auth,
    mcpDeps,
    tenants,
    rateLimits,
    readiness,
    async stopAdmission() {
      await worker.stop();
    },
    async shutdown() {
      await worker.stop();
      await repository.close();
      await rateLimiter.close();
      if (tracing !== undefined) await tracing.shutdown();
      logger.info({ event: 'gateway.shutdown' }, 'Gateway shut down');
    }
  };
}

export async function migrate(config: GatewayConfig): Promise<{ applied: string[] }> {
  if (config.persistence.databaseUrl === undefined) {
    throw new GatewayError('INVALID_INPUT', 'No PostgreSQL connection string is configured.', {
      details: { env: 'HF_MCP_DATABASE_URL' }
    });
  }
  const logger = createLogger({
    level: config.observability.level,
    pretty: config.observability.pretty,
    serviceName: config.observability.serviceName
  });
  return runMigrations({ connectionString: config.persistence.databaseUrl, logger });
}

export function contextFactory(auth: AuthContext, workspaceId?: string): RequestContext {
  return httpRequestContext(auth, workspaceId);
}
