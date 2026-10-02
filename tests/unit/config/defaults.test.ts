import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, loadConfig } from '@higgsfield-mcp/config';
import { makeTempDir } from './helpers.js';

function assertDeepFrozen(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value), `${path || 'CONFIG_DEFAULTS'} must be frozen`).toBe(true);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${path}.${key}`);
}

describe('CONFIG_DEFAULTS', () => {
  it('is deeply frozen', () => {
    assertDeepFrozen(CONFIG_DEFAULTS, '');
  });

  it('documents the documented values', () => {
    expect(CONFIG_DEFAULTS.transport).toBe('stdio');
    expect(CONFIG_DEFAULTS.mode).toBe('local');
    expect(CONFIG_DEFAULTS.server).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      bodyLimitBytes: 1_048_576,
      shutdownGraceMs: 10_000
    });
    expect(CONFIG_DEFAULTS.server.allowedHosts).toEqual(['127.0.0.1', 'localhost']);
    expect(CONFIG_DEFAULTS.server.allowedOrigins).toEqual([]);
    expect(CONFIG_DEFAULTS.provider).toMatchObject({
      baseUrl: 'https://api.higgsfield.ai',
      requestTimeoutMs: 30_000,
      uploadTimeoutMs: 300_000
    });
    expect(CONFIG_DEFAULTS.media).toMatchObject({
      allowedPaths: [],
      assetMode: 'passthrough',
      maxUploadBytes: 104_857_600,
      downloadTimeoutMs: 30_000,
      maxRedirects: 3,
      signedUrlTtlSeconds: 900
    });
    expect(CONFIG_DEFAULTS.storage).toMatchObject({
      region: 'us-east-1',
      forcePathStyle: true,
      prefix: 'higgsfield'
    });
    expect(CONFIG_DEFAULTS.persistence).toMatchObject({ requireDatabase: false, requireRedis: false });
    expect(CONFIG_DEFAULTS.limits).toMatchObject({ maxImageJobs: 10, maxVideoJobs: 3 });
    expect(CONFIG_DEFAULTS.models).toEqual({});
    expect(CONFIG_DEFAULTS.observability).toMatchObject({
      level: 'info',
      pretty: false,
      metricsEnabled: true,
      serviceName: 'higgsfield-mcp'
    });
    expect(CONFIG_DEFAULTS.features).toEqual({ agentApi: false, dynamicModels: false, webhooks: false });
    expect(CONFIG_DEFAULTS.workers).toMatchObject({
      enabled: true,
      pollIntervalFloorMs: 2_000,
      pollIntervalCeilingMs: 10_000,
      transientBackoffMs: 60_000,
      replayBackoffMinMs: 2_000,
      replayBackoffMaxMs: 60_000
    });
  });

  it('describes local stdio mode exactly as loadConfig resolves it', () => {
    const config = loadConfig({ argv: [], env: {}, cwd: makeTempDir() });
    expect(config).toEqual({ ...CONFIG_DEFAULTS });
  });

  it('never hands out its own arrays', () => {
    const config = loadConfig({ argv: [], env: {}, cwd: makeTempDir() });
    config.server.allowedHosts.push('injected.example');
    config.media.allowedPaths.push('/etc');
    expect(CONFIG_DEFAULTS.server.allowedHosts).toEqual(['127.0.0.1', 'localhost']);
    expect(CONFIG_DEFAULTS.media.allowedPaths).toEqual([]);
  });
});
