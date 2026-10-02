import { describe, expect, it } from 'vitest';
import { loadConfig } from '@higgsfield-mcp/config';
import { getPath, makeTempDir, writeJsonFile } from './helpers.js';

describe('configuration precedence', () => {
  it('uses defaults when no layer supplies a value', () => {
    const config = loadConfig({ argv: [], env: {}, cwd: makeTempDir() });
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('lets the config file override defaults', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'gateway.json', { server: { port: 5100, host: '10.0.0.1' } });
    const config = loadConfig({ argv: ['serve', '--config', path], env: {}, cwd });
    expect(config.server.port).toBe(5100);
    expect(config.server.host).toBe('10.0.0.1');
    expect(config.configFile).toBe(path);
  });

  it('lets the environment override the config file', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'gateway.json', { server: { port: 5100 } });
    const config = loadConfig({ argv: ['--config', path], env: { HF_MCP_PORT: '5200' }, cwd });
    expect(config.server.port).toBe(5200);
  });

  it('lets argv override the environment', () => {
    const cwd = makeTempDir();
    const config = loadConfig({ argv: ['--port', '5300'], env: { HF_MCP_PORT: '5200' }, cwd });
    expect(config.server.port).toBe(5300);
  });

  it('lets explicit overrides beat argv', () => {
    const cwd = makeTempDir();
    const config = loadConfig({
      argv: ['--port', '5300', '--host', 'argv.example'],
      env: { HF_MCP_PORT: '5200', HF_MCP_HOST: 'env.example' },
      overrides: { port: 5400, host: 'override.example' },
      cwd
    });
    expect(config.server.port).toBe(5400);
    expect(config.server.host).toBe('override.example');
  });

  it('resolves the whole chain for a single field', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'gateway.json', { observability: { level: 'warn' } });
    const fromFile = loadConfig({ argv: ['--config', path], env: {}, cwd });
    const fromEnv = loadConfig({ argv: ['--config', path], env: { HF_MCP_LOG_LEVEL: 'debug' }, cwd });
    const fromOverrides = loadConfig({
      argv: ['--config', path],
      env: { HF_MCP_LOG_LEVEL: 'debug' },
      overrides: { transport: 'stdio' },
      cwd
    });
    expect(getPath(fromFile, 'observability.level')).toBe('warn');
    expect(getPath(fromEnv, 'observability.level')).toBe('debug');
    expect(fromOverrides.observability.level).toBe('debug');
  });

  it('keeps a config file value when a higher layer does not set the field', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'gateway.json', { limits: { maxImageJobs: 4 }, workers: { enabled: false } });
    const config = loadConfig({ argv: ['--config', path], env: { HF_MCP_MAX_VIDEO_JOBS: '6' }, cwd });
    expect(config.limits.maxImageJobs).toBe(4);
    expect(config.limits.maxVideoJobs).toBe(6);
    expect(config.workers.enabled).toBe(false);
  });
});
