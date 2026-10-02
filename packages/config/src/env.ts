import type { ConfigIssue } from './errors.js';
import { LOG_LEVELS, AUTH_MODES, ASSET_MODES, TRANSPORT_MODES } from './defaults.js';
import { setRawPath, type RawConfig } from './raw.js';
import {
  parseBooleanValue,
  parseEnumValue,
  parseHttpUrl,
  parseIntValue,
  parseListValue,
  parseNonEmptyValue,
  parseNumberValue,
  type IntBounds,
  type ParseResult
} from './parse.js';

/** One environment variable, its target field, and how to parse it. */
export interface EnvSpec {
  readonly key: string;
  /** Dotted path into `RawConfig`. */
  readonly path: string;
  readonly parse: (raw: string) => ParseResult<unknown>;
}

const MILLIS: IntBounds = { min: 1, max: 86_400_000 };
const BYTES: IntBounds = { min: 1 };
const COUNT: IntBounds = { min: 1, max: 10_000 };
const USD: IntBounds = { min: 0, max: 1_000_000_000 };

const text = (maxLength = 4096) => (raw: string) => parseNonEmptyValue(raw, maxLength);
const integer = (bounds: IntBounds) => (raw: string) => parseIntValue(raw, bounds);
const decimal = (bounds: IntBounds) => (raw: string) => parseNumberValue(raw, bounds);
const flag = (raw: string) => parseBooleanValue(raw);
const list = (raw: string) => parseListValue(raw);
const url = (raw: string) => parseHttpUrl(raw);
const httpsUrl = (raw: string) => parseHttpUrl(raw, { httpsOnly: true });
const choice = <const T extends string>(allowed: readonly T[]) => (raw: string) => parseEnumValue(raw, allowed);

/**
 * The complete, public set of environment variables. Adding a key here is the
 * only way to make the loader read it; unknown variables are ignored because
 * the process environment is shared with every other tool.
 */
export const ENV_SPECS: readonly EnvSpec[] = [
  { key: 'HF_API_CREDENTIALS', path: 'provider.credentials', parse: text(8192) },
  { key: 'HF_MCP_PROVIDER_ACCOUNT_ID', path: 'provider.accountId', parse: text(256) },
  { key: 'HF_MCP_PROVIDER_BASE_URL', path: 'provider.baseUrl', parse: url },
  { key: 'HF_MCP_PROVIDER_TIMEOUT_MS', path: 'provider.requestTimeoutMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_PROVIDER_UPLOAD_TIMEOUT_MS', path: 'provider.uploadTimeoutMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_TRANSPORT', path: 'transport', parse: choice(TRANSPORT_MODES) },
  { key: 'HF_MCP_HOST', path: 'server.host', parse: text(255) },
  { key: 'HF_MCP_PORT', path: 'server.port', parse: integer({ min: 1, max: 65_535 }) },
  { key: 'HF_MCP_PUBLIC_URL', path: 'server.publicUrl', parse: url },
  { key: 'HF_MCP_ALLOWED_HOSTS', path: 'server.allowedHosts', parse: list },
  { key: 'HF_MCP_ALLOWED_ORIGINS', path: 'server.allowedOrigins', parse: list },
  { key: 'HF_MCP_BODY_LIMIT_BYTES', path: 'server.bodyLimitBytes', parse: integer(BYTES) },
  { key: 'HF_MCP_SHUTDOWN_GRACE_MS', path: 'server.shutdownGraceMs', parse: integer({ min: 0, max: 600_000 }) },
  { key: 'HF_MCP_AUTH_MODE', path: 'auth.mode', parse: choice(AUTH_MODES) },
  { key: 'HF_MCP_TENANTS_FILE', path: 'auth.tenantsFile', parse: text(1024) },
  { key: 'HF_MCP_METRICS_TOKEN', path: 'auth.metricsToken', parse: text(512) },
  { key: 'HF_MCP_OAUTH_ISSUER', path: 'auth.oauth.issuer', parse: httpsUrl },
  { key: 'HF_MCP_OAUTH_JWKS_URL', path: 'auth.oauth.jwksUrl', parse: httpsUrl },
  { key: 'HF_MCP_OAUTH_AUDIENCE', path: 'auth.oauth.audience', parse: text(512) },
  { key: 'HF_MCP_ALLOWED_PATHS', path: 'media.allowedPaths', parse: list },
  { key: 'HF_MCP_ASSET_MODE', path: 'media.assetMode', parse: choice(ASSET_MODES) },
  { key: 'HF_MCP_MAX_UPLOAD_BYTES', path: 'media.maxUploadBytes', parse: integer(BYTES) },
  { key: 'HF_MCP_DOWNLOAD_TIMEOUT_MS', path: 'media.downloadTimeoutMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_MAX_REDIRECTS', path: 'media.maxRedirects', parse: integer({ min: 0, max: 10 }) },
  { key: 'HF_MCP_SIGNED_URL_TTL_SECONDS', path: 'media.signedUrlTtlSeconds', parse: integer({ min: 1, max: 604_800 }) },
  { key: 'HF_MCP_S3_ENDPOINT', path: 'storage.endpoint', parse: text(1024) },
  { key: 'HF_MCP_S3_REGION', path: 'storage.region', parse: text(64) },
  { key: 'HF_MCP_S3_BUCKET', path: 'storage.bucket', parse: text(255) },
  { key: 'HF_MCP_S3_ACCESS_KEY_ID', path: 'storage.accessKeyId', parse: text(256) },
  { key: 'HF_MCP_S3_SECRET_ACCESS_KEY', path: 'storage.secretAccessKey', parse: text(512) },
  { key: 'HF_MCP_S3_FORCE_PATH_STYLE', path: 'storage.forcePathStyle', parse: flag },
  { key: 'HF_MCP_S3_PREFIX', path: 'storage.prefix', parse: text(256) },
  { key: 'HF_MCP_DATA_ENCRYPTION_KEY', path: 'dataEncryptionKey', parse: text(1024) },
  { key: 'HF_MCP_DATABASE_URL', path: 'persistence.databaseUrl', parse: text(2048) },
  { key: 'HF_MCP_REDIS_URL', path: 'persistence.redisUrl', parse: text(2048) },
  { key: 'HF_MCP_MAX_IMAGE_JOBS', path: 'limits.maxImageJobs', parse: integer(COUNT) },
  { key: 'HF_MCP_MAX_VIDEO_JOBS', path: 'limits.maxVideoJobs', parse: integer(COUNT) },
  { key: 'HF_MCP_RATE_LIMITS_FILE', path: 'limits.rateLimitsFile', parse: text(1024) },
  { key: 'HF_MCP_MAX_JOB_COST_USD', path: 'cost.maxJobCostUsd', parse: decimal(USD) },
  { key: 'HF_MCP_DAILY_COST_LIMIT_USD', path: 'cost.dailyCostLimitUsd', parse: decimal(USD) },
  { key: 'HF_MCP_REQUIRE_CONFIRM_ABOVE_USD', path: 'cost.requireConfirmAboveUsd', parse: decimal(USD) },
  { key: 'HF_MCP_MODEL_ALIASES_FILE', path: 'models.aliasesFile', parse: text(1024) },
  { key: 'HF_MCP_LOG_LEVEL', path: 'observability.level', parse: choice(LOG_LEVELS) },
  { key: 'HF_MCP_LOG_PRETTY', path: 'observability.pretty', parse: flag },
  { key: 'HF_MCP_METRICS_ENABLED', path: 'observability.metricsEnabled', parse: flag },
  { key: 'OTEL_EXPORTER_OTLP_ENDPOINT', path: 'observability.otlpEndpoint', parse: url },
  { key: 'HF_MCP_SERVICE_NAME', path: 'observability.serviceName', parse: text(128) },
  { key: 'HF_MCP_EXPERIMENTAL_AGENT_API', path: 'features.agentApi', parse: flag },
  { key: 'HF_MCP_WEBHOOKS_ENABLED', path: 'features.webhooks', parse: flag },
  { key: 'HF_MCP_WORKERS_ENABLED', path: 'workers.enabled', parse: flag },
  { key: 'HF_MCP_POLL_INTERVAL_FLOOR_MS', path: 'workers.pollIntervalFloorMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_POLL_INTERVAL_CEILING_MS', path: 'workers.pollIntervalCeilingMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_POLL_TRANSIENT_BACKOFF_MS', path: 'workers.transientBackoffMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_REPLAY_BACKOFF_MIN_MS', path: 'workers.replayBackoffMinMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_REPLAY_BACKOFF_MAX_MS', path: 'workers.replayBackoffMaxMs', parse: integer(MILLIS) },
  { key: 'HF_MCP_SKILLS_DIR', path: 'skillsDir', parse: text(1024) }
];

/** Key/path pairs only — the shape tests and tooling can assert completeness against. */
export const ENV_KEY_SPECS: readonly { key: string; path: string }[] = ENV_SPECS.map((spec) => ({
  key: spec.key,
  path: spec.path
}));

/**
 * Reads every known variable into the raw config. Empty (or whitespace-only)
 * values mean "not set": `.env` files routinely carry empty placeholders such
 * as `HF_API_CREDENTIALS=`, and treating those as secrets would be worse than
 * ignoring them. All failures are collected, never short-circuited.
 */
export function applyEnvironment(raw: RawConfig, env: Record<string, string | undefined>, issues: ConfigIssue[]): void {
  for (const spec of ENV_SPECS) {
    const value = env[spec.key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === '') continue;
    const parsed = spec.parse(trimmed);
    if (!parsed.ok) {
      issues.push({ path: spec.path, message: parsed.message });
      continue;
    }
    setRawPath(raw, spec.path, parsed.value);
  }
}
