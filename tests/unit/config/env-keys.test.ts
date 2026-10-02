import { describe, expect, it } from 'vitest';
import { ENV_KEY_SPECS, loadConfig } from '@higgsfield-mcp/config';
import { getPath, expectIssues, makeTempDir, REMOTE_ENV, VALID_ENCRYPTION_KEY } from './helpers.js';

/**
 * The published environment contract (assignment + SPEC §46). Kept as an
 * explicit list so adding a variable in the loader without documenting it — or
 * documenting one that the loader ignores — fails here.
 */
const DOCUMENTED_ENV_KEYS = [
  'HF_API_CREDENTIALS',
  'HF_MCP_PROVIDER_ACCOUNT_ID',
  'HF_MCP_PROVIDER_BASE_URL',
  'HF_MCP_PROVIDER_TIMEOUT_MS',
  'HF_MCP_PROVIDER_UPLOAD_TIMEOUT_MS',
  'HF_MCP_TRANSPORT',
  'HF_MCP_HOST',
  'HF_MCP_PORT',
  'HF_MCP_PUBLIC_URL',
  'HF_MCP_ALLOWED_HOSTS',
  'HF_MCP_ALLOWED_ORIGINS',
  'HF_MCP_BODY_LIMIT_BYTES',
  'HF_MCP_SHUTDOWN_GRACE_MS',
  'HF_MCP_AUTH_MODE',
  'HF_MCP_TENANTS_FILE',
  'HF_MCP_METRICS_TOKEN',
  'HF_MCP_OAUTH_ISSUER',
  'HF_MCP_OAUTH_JWKS_URL',
  'HF_MCP_OAUTH_AUDIENCE',
  'HF_MCP_ALLOWED_PATHS',
  'HF_MCP_ASSET_MODE',
  'HF_MCP_MAX_UPLOAD_BYTES',
  'HF_MCP_DOWNLOAD_TIMEOUT_MS',
  'HF_MCP_MAX_REDIRECTS',
  'HF_MCP_SIGNED_URL_TTL_SECONDS',
  'HF_MCP_S3_ENDPOINT',
  'HF_MCP_S3_REGION',
  'HF_MCP_S3_BUCKET',
  'HF_MCP_S3_ACCESS_KEY_ID',
  'HF_MCP_S3_SECRET_ACCESS_KEY',
  'HF_MCP_S3_FORCE_PATH_STYLE',
  'HF_MCP_S3_PREFIX',
  'HF_MCP_DATA_ENCRYPTION_KEY',
  'HF_MCP_DATABASE_URL',
  'HF_MCP_REDIS_URL',
  'HF_MCP_MAX_IMAGE_JOBS',
  'HF_MCP_MAX_VIDEO_JOBS',
  'HF_MCP_RATE_LIMITS_FILE',
  'HF_MCP_MAX_JOB_COST_USD',
  'HF_MCP_DAILY_COST_LIMIT_USD',
  'HF_MCP_REQUIRE_CONFIRM_ABOVE_USD',
  'HF_MCP_MODEL_ALIASES_FILE',
  'HF_MCP_LOG_LEVEL',
  'HF_MCP_LOG_PRETTY',
  'HF_MCP_METRICS_ENABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'HF_MCP_SERVICE_NAME',
  'HF_MCP_EXPERIMENTAL_AGENT_API',
  'HF_MCP_EXPERIMENTAL_DYNAMIC_MODELS',
  'HF_MCP_WEBHOOKS_ENABLED',
  'HF_MCP_WORKERS_ENABLED',
  'HF_MCP_POLL_INTERVAL_FLOOR_MS',
  'HF_MCP_POLL_INTERVAL_CEILING_MS',
  'HF_MCP_POLL_TRANSIENT_BACKOFF_MS',
  'HF_MCP_REPLAY_BACKOFF_MIN_MS',
  'HF_MCP_REPLAY_BACKOFF_MAX_MS',
  'HF_MCP_SKILLS_DIR'
] as const;

const REMOTE_COMPANIONS: Record<string, string> = { ...REMOTE_ENV };
delete REMOTE_COMPANIONS['HF_MCP_TRANSPORT'];

const MANAGED_COMPANIONS: Record<string, string> = {
  HF_MCP_S3_BUCKET: 'gateway-media',
  HF_MCP_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  HF_MCP_S3_SECRET_ACCESS_KEY: 'secret-example',
  HF_MCP_DATA_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY
};

const OAUTH_COMPANIONS: Record<string, string> = {
  HF_MCP_OAUTH_ISSUER: 'https://issuer.example.com',
  HF_MCP_OAUTH_JWKS_URL: 'https://issuer.example.com/.well-known/jwks.json',
  HF_MCP_OAUTH_AUDIENCE: 'higgsfield-mcp'
};

interface MappingRow {
  key: string;
  path: string;
  value: string;
  expected: unknown;
  companions?: Record<string, string>;
}

const MAPPING_ROWS: MappingRow[] = [
  { key: 'HF_API_CREDENTIALS', path: 'provider.credentials', value: 'Key abc123:secret-value', expected: 'Key abc123:secret-value' },
  { key: 'HF_MCP_PROVIDER_ACCOUNT_ID', path: 'provider.accountId', value: 'acct-1', expected: 'acct-1' },
  { key: 'HF_MCP_PROVIDER_BASE_URL', path: 'provider.baseUrl', value: 'https://api.example.com', expected: 'https://api.example.com' },
  { key: 'HF_MCP_PROVIDER_TIMEOUT_MS', path: 'provider.requestTimeoutMs', value: '1234', expected: 1234 },
  { key: 'HF_MCP_PROVIDER_UPLOAD_TIMEOUT_MS', path: 'provider.uploadTimeoutMs', value: '4321', expected: 4321 },
  { key: 'HF_MCP_TRANSPORT', path: 'transport', value: 'http', expected: 'http', companions: REMOTE_COMPANIONS },
  { key: 'HF_MCP_HOST', path: 'server.host', value: '0.0.0.0', expected: '0.0.0.0' },
  { key: 'HF_MCP_PORT', path: 'server.port', value: '8080', expected: 8080 },
  { key: 'HF_MCP_PUBLIC_URL', path: 'server.publicUrl', value: 'https://gw.example.com', expected: 'https://gw.example.com' },
  { key: 'HF_MCP_ALLOWED_HOSTS', path: 'server.allowedHosts', value: 'a.example, b.example', expected: ['a.example', 'b.example'] },
  { key: 'HF_MCP_ALLOWED_ORIGINS', path: 'server.allowedOrigins', value: 'https://a.example', expected: ['https://a.example'] },
  { key: 'HF_MCP_BODY_LIMIT_BYTES', path: 'server.bodyLimitBytes', value: '2048', expected: 2048 },
  { key: 'HF_MCP_SHUTDOWN_GRACE_MS', path: 'server.shutdownGraceMs', value: '1500', expected: 1500 },
  {
    key: 'HF_MCP_AUTH_MODE',
    path: 'auth.mode',
    value: 'static_token',
    expected: 'static_token',
    companions: { HF_MCP_TENANTS_FILE: '/etc/higgsfield/tenants.json' }
  },
  { key: 'HF_MCP_TENANTS_FILE', path: 'auth.tenantsFile', value: '/etc/higgsfield/tenants.json', expected: '/etc/higgsfield/tenants.json' },
  { key: 'HF_MCP_METRICS_TOKEN', path: 'auth.metricsToken', value: 'metrics-secret', expected: 'metrics-secret' },
  { key: 'HF_MCP_OAUTH_ISSUER', path: 'auth.oauth.issuer', value: OAUTH_COMPANIONS['HF_MCP_OAUTH_ISSUER']!, expected: 'https://issuer.example.com', companions: OAUTH_COMPANIONS },
  {
    key: 'HF_MCP_OAUTH_JWKS_URL',
    path: 'auth.oauth.jwksUrl',
    value: OAUTH_COMPANIONS['HF_MCP_OAUTH_JWKS_URL']!,
    expected: 'https://issuer.example.com/.well-known/jwks.json',
    companions: OAUTH_COMPANIONS
  },
  { key: 'HF_MCP_OAUTH_AUDIENCE', path: 'auth.oauth.audience', value: 'higgsfield-mcp', expected: 'higgsfield-mcp', companions: OAUTH_COMPANIONS },
  { key: 'HF_MCP_ALLOWED_PATHS', path: 'media.allowedPaths', value: '/workspace, /data', expected: ['/workspace', '/data'] },
  { key: 'HF_MCP_ASSET_MODE', path: 'media.assetMode', value: 'managed', expected: 'managed', companions: MANAGED_COMPANIONS },
  { key: 'HF_MCP_MAX_UPLOAD_BYTES', path: 'media.maxUploadBytes', value: '999', expected: 999 },
  { key: 'HF_MCP_DOWNLOAD_TIMEOUT_MS', path: 'media.downloadTimeoutMs', value: '2500', expected: 2500 },
  { key: 'HF_MCP_MAX_REDIRECTS', path: 'media.maxRedirects', value: '5', expected: 5 },
  { key: 'HF_MCP_SIGNED_URL_TTL_SECONDS', path: 'media.signedUrlTtlSeconds', value: '60', expected: 60 },
  { key: 'HF_MCP_S3_ENDPOINT', path: 'storage.endpoint', value: 'https://s3.example.com', expected: 'https://s3.example.com' },
  { key: 'HF_MCP_S3_REGION', path: 'storage.region', value: 'eu-central-1', expected: 'eu-central-1' },
  { key: 'HF_MCP_S3_BUCKET', path: 'storage.bucket', value: 'media-bucket', expected: 'media-bucket' },
  { key: 'HF_MCP_S3_ACCESS_KEY_ID', path: 'storage.accessKeyId', value: 'AKIAEXAMPLE', expected: 'AKIAEXAMPLE' },
  { key: 'HF_MCP_S3_SECRET_ACCESS_KEY', path: 'storage.secretAccessKey', value: 'secret-example', expected: 'secret-example' },
  { key: 'HF_MCP_S3_FORCE_PATH_STYLE', path: 'storage.forcePathStyle', value: 'false', expected: false },
  { key: 'HF_MCP_S3_PREFIX', path: 'storage.prefix', value: 'media', expected: 'media' },
  { key: 'HF_MCP_DATA_ENCRYPTION_KEY', path: 'dataEncryptionKey', value: VALID_ENCRYPTION_KEY, expected: VALID_ENCRYPTION_KEY },
  { key: 'HF_MCP_DATABASE_URL', path: 'persistence.databaseUrl', value: 'postgres://gateway:pw@db.internal:5432/gateway', expected: 'postgres://gateway:pw@db.internal:5432/gateway' },
  { key: 'HF_MCP_REDIS_URL', path: 'persistence.redisUrl', value: 'redis://cache.internal:6379', expected: 'redis://cache.internal:6379' },
  { key: 'HF_MCP_MAX_IMAGE_JOBS', path: 'limits.maxImageJobs', value: '7', expected: 7 },
  { key: 'HF_MCP_MAX_VIDEO_JOBS', path: 'limits.maxVideoJobs', value: '2', expected: 2 },
  { key: 'HF_MCP_RATE_LIMITS_FILE', path: 'limits.rateLimitsFile', value: '/etc/higgsfield/limits.json', expected: '/etc/higgsfield/limits.json' },
  { key: 'HF_MCP_MAX_JOB_COST_USD', path: 'cost.maxJobCostUsd', value: '2.5', expected: 2.5 },
  { key: 'HF_MCP_DAILY_COST_LIMIT_USD', path: 'cost.dailyCostLimitUsd', value: '40', expected: 40 },
  { key: 'HF_MCP_REQUIRE_CONFIRM_ABOVE_USD', path: 'cost.requireConfirmAboveUsd', value: '0.75', expected: 0.75 },
  { key: 'HF_MCP_MODEL_ALIASES_FILE', path: 'models.aliasesFile', value: '/etc/higgsfield/aliases.json', expected: '/etc/higgsfield/aliases.json' },
  { key: 'HF_MCP_LOG_LEVEL', path: 'observability.level', value: 'debug', expected: 'debug' },
  { key: 'HF_MCP_LOG_PRETTY', path: 'observability.pretty', value: 'true', expected: true },
  { key: 'HF_MCP_METRICS_ENABLED', path: 'observability.metricsEnabled', value: 'false', expected: false },
  { key: 'OTEL_EXPORTER_OTLP_ENDPOINT', path: 'observability.otlpEndpoint', value: 'http://collector.internal:4318/v1/traces', expected: 'http://collector.internal:4318/v1/traces' },
  { key: 'HF_MCP_SERVICE_NAME', path: 'observability.serviceName', value: 'gateway-edge', expected: 'gateway-edge' },
  { key: 'HF_MCP_EXPERIMENTAL_AGENT_API', path: 'features.agentApi', value: 'true', expected: true },
  { key: 'HF_MCP_EXPERIMENTAL_DYNAMIC_MODELS', path: 'features.dynamicModels', value: 'true', expected: true },
  {
    key: 'HF_MCP_WEBHOOKS_ENABLED',
    path: 'features.webhooks',
    value: 'false',
    expected: false,
    companions: { HF_MCP_PUBLIC_URL: 'https://gw.example.com' }
  },
  { key: 'HF_MCP_WORKERS_ENABLED', path: 'workers.enabled', value: 'false', expected: false },
  { key: 'HF_MCP_POLL_INTERVAL_FLOOR_MS', path: 'workers.pollIntervalFloorMs', value: '500', expected: 500 },
  { key: 'HF_MCP_POLL_INTERVAL_CEILING_MS', path: 'workers.pollIntervalCeilingMs', value: '5000', expected: 5000 },
  { key: 'HF_MCP_POLL_TRANSIENT_BACKOFF_MS', path: 'workers.transientBackoffMs', value: '30000', expected: 30000 },
  { key: 'HF_MCP_REPLAY_BACKOFF_MIN_MS', path: 'workers.replayBackoffMinMs', value: '1000', expected: 1000 },
  { key: 'HF_MCP_REPLAY_BACKOFF_MAX_MS', path: 'workers.replayBackoffMaxMs', value: '30000', expected: 30000 },
  { key: 'HF_MCP_SKILLS_DIR', path: 'skillsDir', value: '/opt/skills', expected: '/opt/skills' }
];

describe('environment key contract', () => {
  it('documents exactly the variables the loader reads', () => {
    const documented = [...DOCUMENTED_ENV_KEYS].sort();
    const implemented = ENV_KEY_SPECS.map((spec) => spec.key).sort();
    expect(new Set(implemented).size).toBe(implemented.length);
    expect(implemented).toEqual(documented);
  });

  it('has a mapping row for every documented variable', () => {
    expect(MAPPING_ROWS.map((row) => row.key).sort()).toEqual([...DOCUMENTED_ENV_KEYS].sort());
  });

  it.each(MAPPING_ROWS)('$key maps to $path', (row) => {
    const cwd = makeTempDir();
    const env = { ...(row.companions ?? {}), [row.key]: row.value };
    const config = loadConfig({ argv: [], env, cwd });
    expect(getPath(config, row.path)).toEqual(row.expected);
  });

  it.each(ENV_KEY_SPECS)('$key has a documented target path', (spec) => {
    expect(spec.path.length).toBeGreaterThan(0);
    expect(spec.path.startsWith('.')).toBe(false);
  });
});

describe('environment parsing rules', () => {
  it('treats empty values as unset so .env placeholders do not break startup', () => {
    const config = loadConfig({ argv: [], env: { HF_API_CREDENTIALS: '', HF_MCP_PORT: '   ' }, cwd: makeTempDir() });
    expect(config.provider.credentials).toBeUndefined();
    expect(config.server.port).toBe(3000);
  });

  it('rejects malformed numbers with the config path', () => {
    expectIssues(() => loadConfig({ argv: [], env: { HF_MCP_PORT: '3000.5' }, cwd: makeTempDir() }), ['server.port']);
  });

  it('rejects duplicates in comma-separated arrays', () => {
    expectIssues(() => loadConfig({ argv: [], env: { HF_MCP_ALLOWED_PATHS: '/workspace,/workspace' }, cwd: makeTempDir() }), [
      'media.allowedPaths'
    ]);
  });

  it('ignores unknown environment variables', () => {
    const config = loadConfig({ argv: [], env: { HF_MCP_NOT_A_THING: 'x' }, cwd: makeTempDir() });
    expect(config.server.port).toBe(3000);
  });
});

describe('derived values', () => {
  it('derives the provider account id from the credential when local', () => {
    const config = loadConfig({ argv: [], env: { HF_API_CREDENTIALS: 'Key acct-local:secret' }, cwd: makeTempDir() });
    expect(config.provider.accountId).toBe('acct-local');
  });

  it('does not derive the account id in remote mode', () => {
    const config = loadConfig({ argv: [], env: { ...REMOTE_ENV, HF_API_CREDENTIALS: 'Key acct-local:secret' }, cwd: makeTempDir() });
    expect(config.provider.accountId).toBe('acct-remote');
  });

  it('defaults allowed hosts to loopback plus the public hostname', () => {
    const config = loadConfig({ argv: [], env: { HF_MCP_PUBLIC_URL: 'https://gw.example.com' }, cwd: makeTempDir() });
    expect(config.server.allowedHosts).toEqual(['127.0.0.1', 'localhost', 'gw.example.com']);
  });

  it('enables webhooks only when a public URL is configured', () => {
    const without = loadConfig({ argv: [], env: {}, cwd: makeTempDir() });
    const withUrl = loadConfig({ argv: [], env: { HF_MCP_PUBLIC_URL: 'https://gw.example.com' }, cwd: makeTempDir() });
    expect(without.features.webhooks).toBe(false);
    expect(withUrl.features.webhooks).toBe(true);
  });

  it('rejects relative file paths so cwd never changes their meaning', () => {
    expectIssues(() => loadConfig({ argv: [], env: { HF_MCP_TENANTS_FILE: 'config/tenants.json' }, cwd: makeTempDir() }), [
      'auth.tenantsFile'
    ]);
    expectIssues(() => loadConfig({ argv: [], env: { HF_MCP_SKILLS_DIR: 'skills' }, cwd: makeTempDir() }), ['skillsDir']);
  });

  it('does not read the model aliases file at load time', () => {
    const config = loadConfig({ argv: [], env: { HF_MCP_MODEL_ALIASES_FILE: '/nonexistent/aliases.json' }, cwd: makeTempDir() });
    expect(config.models.aliasesFile).toBe('/nonexistent/aliases.json');
  });
});
