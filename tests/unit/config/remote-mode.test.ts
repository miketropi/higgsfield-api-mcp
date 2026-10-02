import { describe, expect, it } from 'vitest';
import { loadConfig } from '@higgsfield-mcp/config';
import { expectIssues, issuePaths, makeTempDir, REMOTE_ENV, VALID_ENCRYPTION_KEY } from './helpers.js';

const REQUIRED_REMOTE_KEYS: [string, string][] = [
  ['HF_MCP_DATABASE_URL', 'persistence.databaseUrl'],
  ['HF_MCP_REDIS_URL', 'persistence.redisUrl'],
  ['HF_MCP_DATA_ENCRYPTION_KEY', 'dataEncryptionKey'],
  ['HF_MCP_TENANTS_FILE', 'auth.tenantsFile'],
  ['HF_MCP_PROVIDER_ACCOUNT_ID', 'provider.accountId']
];

describe('remote mode', () => {
  it('accepts a complete remote configuration', () => {
    const config = loadConfig({ argv: [], env: REMOTE_ENV, cwd: makeTempDir() });
    expect(config.mode).toBe('remote');
    expect(config.transport).toBe('http');
    expect(config.persistence.requireDatabase).toBe(true);
    expect(config.persistence.requireRedis).toBe(true);
    expect(config.auth.mode).toBe('static_token');
    expect(config.server.allowedHosts).toEqual(['127.0.0.1', 'localhost']);
  });

  it.each(REQUIRED_REMOTE_KEYS)('reports %s as its own issue path', (key, path) => {
    const env = { ...REMOTE_ENV };
    delete env[key];
    expectIssues(() => loadConfig({ argv: [], env, cwd: makeTempDir() }), [path]);
  });

  it('reports every missing requirement at once, each with a distinct path', () => {
    const env: Record<string, string> = { HF_MCP_TRANSPORT: 'http', HF_MCP_AUTH_MODE: 'none' };
    const paths = issuePaths(() => loadConfig({ argv: [], env, cwd: makeTempDir() }));
    expect(paths).toEqual([
      'auth.mode',
      'dataEncryptionKey',
      'persistence.databaseUrl',
      'persistence.redisUrl',
      'provider.accountId'
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('rejects authentication mode none in remote mode', () => {
    expectIssues(() => loadConfig({ argv: [], env: { ...REMOTE_ENV, HF_MCP_AUTH_MODE: 'none' }, cwd: makeTempDir() }), ['auth.mode']);
  });

  it('defaults to static_token for the http transport', () => {
    const env = { ...REMOTE_ENV };
    delete env['HF_MCP_AUTH_MODE'];
    expect(loadConfig({ argv: [], env, cwd: makeTempDir() }).auth.mode).toBe('static_token');
  });

  it('requires a well-formed 32-byte encryption key', () => {
    expectIssues(() => loadConfig({ argv: [], env: { ...REMOTE_ENV, HF_MCP_DATA_ENCRYPTION_KEY: 'c2hvcnQ=' }, cwd: makeTempDir() }), [
      'dataEncryptionKey'
    ]);
    expect(loadConfig({ argv: [], env: REMOTE_ENV, cwd: makeTempDir() }).dataEncryptionKey).toBe(VALID_ENCRYPTION_KEY);
  });

  it('requires oauth issuer, jwks url, and audience together', () => {
    const env = { ...REMOTE_ENV, HF_MCP_AUTH_MODE: 'oauth_jwt', HF_MCP_OAUTH_ISSUER: 'https://issuer.example.com' };
    expectIssues(() => loadConfig({ argv: [], env, cwd: makeTempDir() }), ['auth.oauth.jwksUrl', 'auth.oauth.audience']);
  });

  it('works with only the provider credential in local stdio mode', () => {
    const config = loadConfig({ argv: [], env: { HF_API_CREDENTIALS: 'Key acct:secret' }, cwd: makeTempDir() });
    expect(config.mode).toBe('local');
    expect(config.persistence).toMatchObject({ requireDatabase: false, requireRedis: false });
    expect(config.persistence.databaseUrl).toBeUndefined();
    expect(config.persistence.redisUrl).toBeUndefined();
    expect(config.auth.mode).toBe('none');
    expect(config.dataEncryptionKey).toBeUndefined();
    expect(config.server.allowedHosts).toEqual(['127.0.0.1', 'localhost']);
    expect(config.server.allowedOrigins).toEqual([]);
    expect(config.media.allowedPaths).toEqual([]);
  });

  it('rejects a local auth mode without a tenants file', () => {
    expectIssues(() => loadConfig({ argv: [], env: { HF_MCP_AUTH_MODE: 'static_token' }, cwd: makeTempDir() }), ['auth.tenantsFile']);
  });
});

describe('managed asset mode', () => {
  const MANAGED_BASE = { HF_MCP_ASSET_MODE: 'managed' };

  it('requires storage configuration and the encryption key in local mode', () => {
    expectIssues(() => loadConfig({ argv: [], env: MANAGED_BASE, cwd: makeTempDir() }), [
      'storage.bucket',
      'storage.accessKeyId',
      'storage.secretAccessKey',
      'dataEncryptionKey'
    ]);
  });

  it('accepts a complete managed configuration', () => {
    const env = {
      ...MANAGED_BASE,
      HF_MCP_S3_BUCKET: 'media',
      HF_MCP_S3_ACCESS_KEY_ID: 'AKIA',
      HF_MCP_S3_SECRET_ACCESS_KEY: 'secret',
      HF_MCP_DATA_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY
    };
    const config = loadConfig({ argv: [], env, cwd: makeTempDir() });
    expect(config.media.assetMode).toBe('managed');
    expect(config.storage).toMatchObject({ bucket: 'media', region: 'us-east-1', forcePathStyle: true, prefix: 'higgsfield' });
  });

  it('rejects a malformed encryption key outside remote mode', () => {
    const env = {
      ...MANAGED_BASE,
      HF_MCP_S3_BUCKET: 'media',
      HF_MCP_S3_ACCESS_KEY_ID: 'AKIA',
      HF_MCP_S3_SECRET_ACCESS_KEY: 'secret',
      HF_MCP_DATA_ENCRYPTION_KEY: 'not-base64!!'
    };
    expectIssues(() => loadConfig({ argv: [], env, cwd: makeTempDir() }), ['dataEncryptionKey']);
  });
});

describe('worker and storage cross-field rules', () => {
  it('rejects an inverted poll interval window', () => {
    const env = { HF_MCP_POLL_INTERVAL_FLOOR_MS: '9000', HF_MCP_POLL_INTERVAL_CEILING_MS: '1000' };
    expectIssues(() => loadConfig({ argv: [], env, cwd: makeTempDir() }), ['workers.pollIntervalCeilingMs']);
  });

  it('rejects an inverted replay backoff window', () => {
    const env = { HF_MCP_REPLAY_BACKOFF_MIN_MS: '90000', HF_MCP_REPLAY_BACKOFF_MAX_MS: '1000' };
    expectIssues(() => loadConfig({ argv: [], env, cwd: makeTempDir() }), ['workers.replayBackoffMaxMs']);
  });

  it('rejects a database url without a scheme authority', () => {
    expectIssues(() => loadConfig({ argv: [], env: { HF_MCP_DATABASE_URL: 'localhost:5432' }, cwd: makeTempDir() }), [
      'persistence.databaseUrl'
    ]);
  });
});
