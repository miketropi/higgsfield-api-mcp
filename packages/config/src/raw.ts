import { CONFIG_DEFAULTS } from './defaults.js';
import type { AssetMode, AuthMode, TransportMode } from './types.js';

/** The OAuth block, assembled leaf-by-leaf from any layer. */
export interface RawOauthConfig {
  issuer?: string | undefined;
  jwksUrl?: string | undefined;
  audience?: string | undefined;
}

/**
 * Layer-merged configuration before derivation and validation.
 *
 * `undefined` on an optional field means "no layer supplied it", which is what
 * distinguishes a derived value (mode, allowedHosts, webhooks) from an explicit
 * one. Required fields start at their documented default so every layer only
 * has to write the fields it actually overrides.
 */
export interface RawConfig {
  transport: TransportMode;
  server: {
    host: string;
    port: number;
    publicUrl?: string | undefined;
    allowedHosts?: string[] | undefined;
    allowedOrigins?: string[] | undefined;
    bodyLimitBytes: number;
    shutdownGraceMs: number;
  };
  auth: {
    mode?: AuthMode | undefined;
    tenantsFile?: string | undefined;
    metricsToken?: string | undefined;
    oauth?: RawOauthConfig | undefined;
  };
  provider: {
    credentials?: string | undefined;
    accountId?: string | undefined;
    baseUrl: string;
    requestTimeoutMs: number;
    uploadTimeoutMs: number;
  };
  media: {
    allowedPaths?: string[] | undefined;
    assetMode: AssetMode;
    maxUploadBytes: number;
    downloadTimeoutMs: number;
    maxRedirects: number;
    signedUrlTtlSeconds: number;
  };
  storage: {
    endpoint?: string | undefined;
    region: string;
    bucket?: string | undefined;
    accessKeyId?: string | undefined;
    secretAccessKey?: string | undefined;
    forcePathStyle: boolean;
    prefix: string;
  };
  persistence: {
    databaseUrl?: string | undefined;
    redisUrl?: string | undefined;
  };
  limits: {
    maxImageJobs: number;
    maxVideoJobs: number;
    rateLimitsFile?: string | undefined;
  };
  models: {
    aliasesFile?: string | undefined;
  };
  cost: {
    maxJobCostUsd?: number | undefined;
    dailyCostLimitUsd?: number | undefined;
    requireConfirmAboveUsd?: number | undefined;
  };
  observability: {
    level: string;
    pretty: boolean;
    metricsEnabled: boolean;
    otlpEndpoint?: string | undefined;
    serviceName: string;
  };
  features: {
    agentApi: boolean;
    dynamicModels: boolean;
    webhooks?: boolean | undefined;
  };
  workers: {
    enabled: boolean;
    pollIntervalFloorMs: number;
    pollIntervalCeilingMs: number;
    transientBackoffMs: number;
    replayBackoffMinMs: number;
    replayBackoffMaxMs: number;
  };
  dataEncryptionKey?: string | undefined;
  skillsDir?: string | undefined;
  configFile?: string | undefined;
}

/** Fresh, unfrozen copy of the documented defaults with "not supplied" markers. */
export function createRawConfig(): RawConfig {
  const defaults = CONFIG_DEFAULTS;
  return {
    transport: defaults.transport,
    server: {
      host: defaults.server.host,
      port: defaults.server.port,
      publicUrl: undefined,
      allowedHosts: undefined,
      allowedOrigins: undefined,
      bodyLimitBytes: defaults.server.bodyLimitBytes,
      shutdownGraceMs: defaults.server.shutdownGraceMs
    },
    auth: { mode: undefined, tenantsFile: undefined, metricsToken: undefined, oauth: undefined },
    provider: {
      credentials: undefined,
      accountId: undefined,
      baseUrl: defaults.provider.baseUrl,
      requestTimeoutMs: defaults.provider.requestTimeoutMs,
      uploadTimeoutMs: defaults.provider.uploadTimeoutMs
    },
    media: {
      allowedPaths: undefined,
      assetMode: defaults.media.assetMode,
      maxUploadBytes: defaults.media.maxUploadBytes,
      downloadTimeoutMs: defaults.media.downloadTimeoutMs,
      maxRedirects: defaults.media.maxRedirects,
      signedUrlTtlSeconds: defaults.media.signedUrlTtlSeconds
    },
    storage: {
      endpoint: undefined,
      region: defaults.storage.region,
      bucket: undefined,
      accessKeyId: undefined,
      secretAccessKey: undefined,
      forcePathStyle: defaults.storage.forcePathStyle,
      prefix: defaults.storage.prefix
    },
    persistence: { databaseUrl: undefined, redisUrl: undefined },
    limits: {
      maxImageJobs: defaults.limits.maxImageJobs,
      maxVideoJobs: defaults.limits.maxVideoJobs,
      rateLimitsFile: undefined
    },
    models: { aliasesFile: undefined },
    cost: { maxJobCostUsd: undefined, dailyCostLimitUsd: undefined, requireConfirmAboveUsd: undefined },
    observability: {
      level: defaults.observability.level,
      pretty: defaults.observability.pretty,
      metricsEnabled: defaults.observability.metricsEnabled,
      otlpEndpoint: undefined,
      serviceName: defaults.observability.serviceName
    },
    features: { agentApi: defaults.features.agentApi, dynamicModels: defaults.features.dynamicModels, webhooks: undefined },
    workers: {
      enabled: defaults.workers.enabled,
      pollIntervalFloorMs: defaults.workers.pollIntervalFloorMs,
      pollIntervalCeilingMs: defaults.workers.pollIntervalCeilingMs,
      transientBackoffMs: defaults.workers.transientBackoffMs,
      replayBackoffMinMs: defaults.workers.replayBackoffMinMs,
      replayBackoffMaxMs: defaults.workers.replayBackoffMaxMs
    },
    dataEncryptionKey: undefined,
    skillsDir: undefined,
    configFile: undefined
  };
}

/**
 * Writes a value at a dotted path, creating intermediate objects. Internal to
 * the loader: the paths are compile-time constants in the spec tables, and the
 * resulting graph is handed to Zod for the authoritative validation.
 */
export function setRawPath(target: object, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target as Record<string, unknown>;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) return;
    const existing = cursor[segment];
    if (typeof existing === 'object' && existing !== null) {
      cursor = existing as Record<string, unknown>;
      continue;
    }
    const created: Record<string, unknown> = {};
    cursor[segment] = created;
    cursor = created;
  }
  const leaf = segments[segments.length - 1];
  if (leaf !== undefined) cursor[leaf] = value;
}

/** Reads a value at a dotted path; used by tests and by derivation helpers. */
export function getRawPath(source: object, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
