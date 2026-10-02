import type { GatewayConfig } from './types.js';

/**
 * Recursively freezes an object graph so the exported defaults cannot be
 * mutated by a consumer that accidentally treats them as the live config.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Pino-compatible log levels accepted by `HF_MCP_LOG_LEVEL` / `observability.level`. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const TRANSPORT_MODES = ['stdio', 'http'] as const;
export const ASSET_MODES = ['passthrough', 'managed'] as const;
export const AUTH_MODES = ['none', 'static_token', 'oauth_jwt'] as const;

/**
 * Documented defaults. Documentation lives here and in SPEC §46; every value
 * below is what the gateway uses when neither CLI flags, environment, nor a
 * config file supply the field.
 *
 * `persistence.requireDatabase` / `requireRedis` are `false` here because the
 * defaults describe local stdio mode; `loadConfig` derives them from the
 * resolved transport. `features.webhooks` is `false` because no
 * `server.publicUrl` is set, which is exactly the derivation rule.
 */
export const CONFIG_DEFAULTS: Readonly<GatewayConfig> = deepFreeze<GatewayConfig>({
  transport: 'stdio',
  mode: 'local',
  server: {
    host: '127.0.0.1',
    port: 3000,
    publicUrl: undefined,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: [],
    bodyLimitBytes: 1_048_576,
    shutdownGraceMs: 10_000
  },
  auth: {
    mode: 'none',
    tenantsFile: undefined,
    metricsToken: undefined,
    oauth: undefined
  },
  provider: {
    credentials: undefined,
    accountId: undefined,
    baseUrl: 'https://api.higgsfield.ai',
    requestTimeoutMs: 30_000,
    uploadTimeoutMs: 300_000
  },
  media: {
    allowedPaths: [],
    assetMode: 'passthrough',
    maxUploadBytes: 104_857_600,
    downloadTimeoutMs: 30_000,
    maxRedirects: 3,
    signedUrlTtlSeconds: 900
  },
  storage: {
    endpoint: undefined,
    region: 'us-east-1',
    bucket: undefined,
    accessKeyId: undefined,
    secretAccessKey: undefined,
    forcePathStyle: true,
    prefix: 'higgsfield'
  },
  persistence: {
    databaseUrl: undefined,
    redisUrl: undefined,
    requireDatabase: false,
    requireRedis: false
  },
  limits: {
    maxImageJobs: 10,
    maxVideoJobs: 3,
    rateLimitsFile: undefined
  },
  models: {},
  cost: {
    maxJobCostUsd: undefined,
    dailyCostLimitUsd: undefined,
    requireConfirmAboveUsd: undefined
  },
  observability: {
    level: 'info',
    pretty: false,
    metricsEnabled: true,
    otlpEndpoint: undefined,
    serviceName: 'higgsfield-mcp'
  },
  features: {
    agentApi: false,
    webhooks: false
  },
  workers: {
    enabled: true,
    pollIntervalFloorMs: 2_000,
    pollIntervalCeilingMs: 10_000,
    transientBackoffMs: 60_000,
    replayBackoffMinMs: 2_000,
    replayBackoffMaxMs: 60_000
  },
  dataEncryptionKey: undefined,
  skillsDir: undefined,
  configFile: undefined
});
