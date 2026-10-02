import { resolve } from 'node:path';
import { parseGlobalFlags, type CliOverrides } from './cli.js';
import { ConfigValidationError, formatIssuePath, type ConfigIssue } from './errors.js';
import { applyEnvironment } from './env.js';
import { readConfigFile, type ConfigFileData } from './files.js';
import { isValidEncryptionKey, parseAbsolutePath, parseIntValue, parseNonEmptyValue } from './parse.js';
import { createRawConfig, getRawPath, type RawConfig } from './raw.js';
import { gatewayConfigSchema } from './schema.js';
import type { AuthMode, GatewayConfig, TransportMode } from './types.js';

export interface LoadConfigInput {
  /** Full process argv slice; only global flags are consumed, everything else is positional. */
  argv?: readonly string[];
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.cwd()`. Relative file paths resolve against it. */
  cwd?: string;
  /** Explicit typed overrides; they win over parsed argv. */
  overrides?: CliOverrides;
}

/** File-valued settings: absolute paths only, so `cwd` never changes meaning. */
const PATH_FIELDS = ['auth.tenantsFile', 'limits.rateLimitsFile', 'models.aliasesFile', 'skillsDir'] as const;

/** `scheme://…`; rejects `host:port` typos that `new URL` happily parses. */
const SCHEME_AUTHORITY_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

function collectPathFieldIssues(raw: RawConfig, issues: ConfigIssue[]): void {
  for (const field of PATH_FIELDS) {
    const value = getRawPath(raw, field);
    if (typeof value !== 'string') continue;
    const parsed = parseAbsolutePath(value);
    if (!parsed.ok) issues.push({ path: field, message: parsed.message });
  }
}

function applyCliLayer(raw: RawConfig, flags: CliOverrides, issues: ConfigIssue[]): void {
  if (flags.config !== undefined) raw.configFile = flags.config;
  if (flags.transport !== undefined) raw.transport = flags.transport;
  if (flags.host !== undefined) {
    const host = parseNonEmptyValue(flags.host, 255);
    if (host.ok) raw.server.host = host.value;
    else issues.push({ path: 'server.host', message: host.message });
  }
  if (flags.port !== undefined) {
    const port = parseIntValue(String(flags.port), { min: 1, max: 65_535 });
    if (port.ok) raw.server.port = port.value;
    else issues.push({ path: 'server.port', message: port.message });
  }
}

/**
 * Merges the optional JSON config file. Secrets are rejected by the file
 * schema, so every field copied here is safe to keep in a repository.
 */
function mergeConfigFile(raw: RawConfig, file: ConfigFileData): void {
  if (file.transport !== undefined) raw.transport = file.transport;

  const server = file.server;
  if (server !== undefined) {
    if (server.host !== undefined) raw.server.host = server.host;
    if (server.port !== undefined) raw.server.port = server.port;
    if (server.publicUrl !== undefined) raw.server.publicUrl = server.publicUrl;
    if (server.allowedHosts !== undefined) raw.server.allowedHosts = [...server.allowedHosts];
    if (server.allowedOrigins !== undefined) raw.server.allowedOrigins = [...server.allowedOrigins];
    if (server.bodyLimitBytes !== undefined) raw.server.bodyLimitBytes = server.bodyLimitBytes;
    if (server.shutdownGraceMs !== undefined) raw.server.shutdownGraceMs = server.shutdownGraceMs;
  }

  const auth = file.auth;
  if (auth !== undefined) {
    if (auth.mode !== undefined) raw.auth.mode = auth.mode;
    if (auth.tenantsFile !== undefined) raw.auth.tenantsFile = auth.tenantsFile;
    if (auth.oauth !== undefined) raw.auth.oauth = { ...raw.auth.oauth, ...auth.oauth };
  }

  const provider = file.provider;
  if (provider !== undefined) {
    if (provider.accountId !== undefined) raw.provider.accountId = provider.accountId;
    if (provider.baseUrl !== undefined) raw.provider.baseUrl = provider.baseUrl;
    if (provider.requestTimeoutMs !== undefined) raw.provider.requestTimeoutMs = provider.requestTimeoutMs;
    if (provider.uploadTimeoutMs !== undefined) raw.provider.uploadTimeoutMs = provider.uploadTimeoutMs;
  }

  const media = file.media;
  if (media !== undefined) {
    if (media.allowedPaths !== undefined) raw.media.allowedPaths = [...media.allowedPaths];
    if (media.assetMode !== undefined) raw.media.assetMode = media.assetMode;
    if (media.maxUploadBytes !== undefined) raw.media.maxUploadBytes = media.maxUploadBytes;
    if (media.downloadTimeoutMs !== undefined) raw.media.downloadTimeoutMs = media.downloadTimeoutMs;
    if (media.maxRedirects !== undefined) raw.media.maxRedirects = media.maxRedirects;
    if (media.signedUrlTtlSeconds !== undefined) raw.media.signedUrlTtlSeconds = media.signedUrlTtlSeconds;
  }

  const storage = file.storage;
  if (storage !== undefined) {
    if (storage.endpoint !== undefined) raw.storage.endpoint = storage.endpoint;
    if (storage.region !== undefined) raw.storage.region = storage.region;
    if (storage.bucket !== undefined) raw.storage.bucket = storage.bucket;
    if (storage.forcePathStyle !== undefined) raw.storage.forcePathStyle = storage.forcePathStyle;
    if (storage.prefix !== undefined) raw.storage.prefix = storage.prefix;
  }

  const limits = file.limits;
  if (limits !== undefined) {
    if (limits.maxImageJobs !== undefined) raw.limits.maxImageJobs = limits.maxImageJobs;
    if (limits.maxVideoJobs !== undefined) raw.limits.maxVideoJobs = limits.maxVideoJobs;
    if (limits.rateLimitsFile !== undefined) raw.limits.rateLimitsFile = limits.rateLimitsFile;
  }

  const models = file.models;
  if (models !== undefined) {
    if (models.aliasesFile !== undefined) raw.models.aliasesFile = models.aliasesFile;
  }

  const cost = file.cost;
  if (cost !== undefined) {
    if (cost.maxJobCostUsd !== undefined) raw.cost.maxJobCostUsd = cost.maxJobCostUsd;
    if (cost.dailyCostLimitUsd !== undefined) raw.cost.dailyCostLimitUsd = cost.dailyCostLimitUsd;
    if (cost.requireConfirmAboveUsd !== undefined) raw.cost.requireConfirmAboveUsd = cost.requireConfirmAboveUsd;
  }

  const observability = file.observability;
  if (observability !== undefined) {
    if (observability.level !== undefined) raw.observability.level = observability.level;
    if (observability.pretty !== undefined) raw.observability.pretty = observability.pretty;
    if (observability.metricsEnabled !== undefined) raw.observability.metricsEnabled = observability.metricsEnabled;
    if (observability.otlpEndpoint !== undefined) raw.observability.otlpEndpoint = observability.otlpEndpoint;
    if (observability.serviceName !== undefined) raw.observability.serviceName = observability.serviceName;
  }

  const features = file.features;
  if (features !== undefined) {
    if (features.agentApi !== undefined) raw.features.agentApi = features.agentApi;
    if (features.dynamicModels !== undefined) raw.features.dynamicModels = features.dynamicModels;
    if (features.webhooks !== undefined) raw.features.webhooks = features.webhooks;
  }

  const workers = file.workers;
  if (workers !== undefined) {
    if (workers.enabled !== undefined) raw.workers.enabled = workers.enabled;
    if (workers.pollIntervalFloorMs !== undefined) raw.workers.pollIntervalFloorMs = workers.pollIntervalFloorMs;
    if (workers.pollIntervalCeilingMs !== undefined) raw.workers.pollIntervalCeilingMs = workers.pollIntervalCeilingMs;
    if (workers.transientBackoffMs !== undefined) raw.workers.transientBackoffMs = workers.transientBackoffMs;
    if (workers.replayBackoffMinMs !== undefined) raw.workers.replayBackoffMinMs = workers.replayBackoffMinMs;
    if (workers.replayBackoffMaxMs !== undefined) raw.workers.replayBackoffMaxMs = workers.replayBackoffMaxMs;
  }

  if (file.skillsDir !== undefined) raw.skillsDir = file.skillsDir;
}

/**
 * `HF_API_CREDENTIALS` is formatted `Key <id>:<secret>`; the id is the upstream
 * account binding, so local mode can derive it instead of asking for it twice.
 */
function deriveAccountIdFromCredentials(credentials: string): string | undefined {
  const withoutPrefix = credentials.replace(/^Key\s+/i, '');
  const separator = withoutPrefix.indexOf(':');
  if (separator <= 0) return undefined;
  const id = withoutPrefix.slice(0, separator).trim();
  return id === '' || /\s/.test(id) ? undefined : id;
}

/** `127.0.0.1`, `localhost`, plus the public hostname when one is configured. */
function deriveAllowedHosts(publicUrl: string | undefined): string[] {
  const hosts = ['127.0.0.1', 'localhost'];
  if (publicUrl !== undefined) {
    const hostname = new URL(publicUrl).hostname;
    if (hostname !== '' && !hosts.includes(hostname)) hosts.push(hostname);
  }
  return hosts;
}

function collectCrossFieldIssues(config: GatewayConfig, issues: ConfigIssue[]): void {
  const remote = config.mode === 'remote';

  if (remote) {
    if (config.persistence.databaseUrl === undefined) {
      issues.push({ path: 'persistence.databaseUrl', message: 'remote mode requires HF_MCP_DATABASE_URL' });
    }
    if (config.persistence.redisUrl === undefined) {
      issues.push({ path: 'persistence.redisUrl', message: 'remote mode requires HF_MCP_REDIS_URL' });
    }
    if (config.dataEncryptionKey === undefined) {
      issues.push({ path: 'dataEncryptionKey', message: 'remote mode requires HF_MCP_DATA_ENCRYPTION_KEY' });
    }
    if (config.auth.mode === 'none') {
      issues.push({ path: 'auth.mode', message: 'remote mode requires authentication (static_token or oauth_jwt)' });
    }
    if (config.provider.accountId === undefined) {
      issues.push({ path: 'provider.accountId', message: 'remote mode requires HF_MCP_PROVIDER_ACCOUNT_ID' });
    }
  }

  if (config.dataEncryptionKey !== undefined && !isValidEncryptionKey(config.dataEncryptionKey)) {
    issues.push({ path: 'dataEncryptionKey', message: 'must be base64 encoding exactly 32 bytes' });
  }

  if (config.persistence.databaseUrl !== undefined && !SCHEME_AUTHORITY_PATTERN.test(config.persistence.databaseUrl)) {
    issues.push({
      path: 'persistence.databaseUrl',
      message: 'must be an absolute URL with an authority, e.g. postgres://user:pass@host:5432/database'
    });
  }
  if (config.persistence.redisUrl !== undefined && !SCHEME_AUTHORITY_PATTERN.test(config.persistence.redisUrl)) {
    issues.push({ path: 'persistence.redisUrl', message: 'must be an absolute URL with an authority, e.g. redis://host:6379' });
  }

  if (config.auth.mode !== 'none' && config.auth.tenantsFile === undefined) {
    issues.push({ path: 'auth.tenantsFile', message: `HF_MCP_TENANTS_FILE is required when auth mode is '${config.auth.mode}'` });
  }

  if (config.media.assetMode === 'managed') {
    if (config.storage.bucket === undefined) {
      issues.push({ path: 'storage.bucket', message: "assetMode 'managed' requires HF_MCP_S3_BUCKET" });
    }
    if (config.storage.accessKeyId === undefined) {
      issues.push({ path: 'storage.accessKeyId', message: "assetMode 'managed' requires HF_MCP_S3_ACCESS_KEY_ID" });
    }
    if (config.storage.secretAccessKey === undefined) {
      issues.push({ path: 'storage.secretAccessKey', message: "assetMode 'managed' requires HF_MCP_S3_SECRET_ACCESS_KEY" });
    }
    if (config.dataEncryptionKey === undefined) {
      issues.push({ path: 'dataEncryptionKey', message: "assetMode 'managed' requires HF_MCP_DATA_ENCRYPTION_KEY" });
    }
  }

  if (config.server.allowedHosts.includes('*')) {
    issues.push({ path: 'server.allowedHosts', message: 'wildcard "*" is not allowed' });
  }
  if (config.server.allowedOrigins.includes('*')) {
    issues.push({ path: 'server.allowedOrigins', message: 'wildcard "*" is not allowed; list explicit origins' });
  }

  for (const pattern of config.media.allowedPaths) {
    const parsed = parseAbsolutePath(pattern);
    if (!parsed.ok) issues.push({ path: 'media.allowedPaths', message: parsed.message });
  }

  if (config.workers.pollIntervalFloorMs > config.workers.pollIntervalCeilingMs) {
    issues.push({ path: 'workers.pollIntervalCeilingMs', message: 'must be >= workers.pollIntervalFloorMs' });
  }
  if (config.workers.replayBackoffMinMs > config.workers.replayBackoffMaxMs) {
    issues.push({ path: 'workers.replayBackoffMaxMs', message: 'must be >= workers.replayBackoffMinMs' });
  }
}

function resolveConfigFilePath(raw: RawConfig, cwd: string): void {
  if (raw.configFile !== undefined) raw.configFile = resolve(cwd, raw.configFile);
}

/**
 * Resolves the gateway configuration with the documented precedence:
 * explicit `overrides` > parsed argv flags > environment > JSON config file >
 * built-in defaults. The merged result is validated as a whole — numeric
 * bounds, enums, URLs, and cross-field requirements — and every problem is
 * reported in a single `ConfigValidationError`.
 */
export function loadConfig(input: LoadConfigInput = {}): GatewayConfig {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();

  const { flags } = parseGlobalFlags(argv);
  const issues: ConfigIssue[] = [];
  const raw = createRawConfig();

  const configPath = input.overrides?.config ?? flags.config;
  if (configPath !== undefined) {
    raw.configFile = configPath;
    mergeConfigFile(raw, readConfigFile(resolve(cwd, configPath)));
  }

  applyEnvironment(raw, env, issues);
  applyCliLayer(raw, flags, issues);
  if (input.overrides !== undefined) applyCliLayer(raw, input.overrides, issues);

  resolveConfigFilePath(raw, cwd);
  collectPathFieldIssues(raw, issues);

  const mode = raw.transport === 'http' ? 'remote' : 'local';
  const transport: TransportMode = raw.transport;
  const authMode: AuthMode = raw.auth.mode ?? (raw.transport === 'http' ? 'static_token' : 'none');
  const oauth = raw.auth.oauth;
  const completeOauth =
    oauth !== undefined && oauth.issuer !== undefined && oauth.jwksUrl !== undefined && oauth.audience !== undefined
      ? { issuer: oauth.issuer, jwksUrl: oauth.jwksUrl, audience: oauth.audience }
      : undefined;
  if (oauth === undefined) {
    if (authMode === 'oauth_jwt') {
      issues.push({ path: 'auth.oauth', message: 'oauth_jwt requires HF_MCP_OAUTH_ISSUER, HF_MCP_OAUTH_JWKS_URL, and HF_MCP_OAUTH_AUDIENCE' });
    }
  } else if (completeOauth === undefined) {
    for (const key of ['issuer', 'jwksUrl', 'audience'] as const) {
      if (oauth[key] === undefined) {
        issues.push({ path: `auth.oauth.${key}`, message: 'required whenever any oauth field is set' });
      }
    }
  }

  const candidate: GatewayConfig = {
    transport,
    mode,
    server: {
      host: raw.server.host,
      port: raw.server.port,
      publicUrl: raw.server.publicUrl,
      allowedHosts: raw.server.allowedHosts ?? deriveAllowedHosts(raw.server.publicUrl),
      allowedOrigins: raw.server.allowedOrigins ?? [],
      bodyLimitBytes: raw.server.bodyLimitBytes,
      shutdownGraceMs: raw.server.shutdownGraceMs
    },
    auth: {
      mode: authMode,
      tenantsFile: raw.auth.tenantsFile,
      metricsToken: raw.auth.metricsToken,
      oauth: completeOauth
    },
    provider: {
      credentials: raw.provider.credentials,
      accountId: raw.provider.accountId ?? (mode === 'local' ? deriveAccountIdFromCredentials(raw.provider.credentials ?? '') : undefined),
      baseUrl: raw.provider.baseUrl,
      requestTimeoutMs: raw.provider.requestTimeoutMs,
      uploadTimeoutMs: raw.provider.uploadTimeoutMs
    },
    media: {
      allowedPaths: [...(raw.media.allowedPaths ?? [])],
      assetMode: raw.media.assetMode,
      maxUploadBytes: raw.media.maxUploadBytes,
      downloadTimeoutMs: raw.media.downloadTimeoutMs,
      maxRedirects: raw.media.maxRedirects,
      signedUrlTtlSeconds: raw.media.signedUrlTtlSeconds
    },
    storage: {
      endpoint: raw.storage.endpoint,
      region: raw.storage.region,
      bucket: raw.storage.bucket,
      accessKeyId: raw.storage.accessKeyId,
      secretAccessKey: raw.storage.secretAccessKey,
      forcePathStyle: raw.storage.forcePathStyle,
      prefix: raw.storage.prefix
    },
    persistence: {
      databaseUrl: raw.persistence.databaseUrl,
      redisUrl: raw.persistence.redisUrl,
      requireDatabase: mode === 'remote',
      requireRedis: mode === 'remote'
    },
    limits: {
      maxImageJobs: raw.limits.maxImageJobs,
      maxVideoJobs: raw.limits.maxVideoJobs,
      rateLimitsFile: raw.limits.rateLimitsFile
    },
    models: {
      aliasesFile: raw.models.aliasesFile
    },
    cost: {
      maxJobCostUsd: raw.cost.maxJobCostUsd,
      dailyCostLimitUsd: raw.cost.dailyCostLimitUsd,
      requireConfirmAboveUsd: raw.cost.requireConfirmAboveUsd
    },
    observability: {
      level: raw.observability.level,
      pretty: raw.observability.pretty,
      metricsEnabled: raw.observability.metricsEnabled,
      otlpEndpoint: raw.observability.otlpEndpoint,
      serviceName: raw.observability.serviceName
    },
    features: {
      agentApi: raw.features.agentApi,
      dynamicModels: raw.features.dynamicModels,
      webhooks: raw.features.webhooks ?? (raw.server.publicUrl !== undefined)
    },
    workers: {
      enabled: raw.workers.enabled,
      pollIntervalFloorMs: raw.workers.pollIntervalFloorMs,
      pollIntervalCeilingMs: raw.workers.pollIntervalCeilingMs,
      transientBackoffMs: raw.workers.transientBackoffMs,
      replayBackoffMinMs: raw.workers.replayBackoffMinMs,
      replayBackoffMaxMs: raw.workers.replayBackoffMaxMs
    },
    dataEncryptionKey: raw.dataEncryptionKey,
    skillsDir: raw.skillsDir,
    configFile: raw.configFile
  };

  const parsed = gatewayConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ path: formatIssuePath(issue.path), message: issue.message });
    }
  }

  collectCrossFieldIssues(candidate, issues);
  if (issues.length > 0) throw new ConfigValidationError(issues);

  return candidate;
}
