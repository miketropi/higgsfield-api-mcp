import { describe, expect, it } from 'vitest';
import { loadConfig, parseGlobalFlags } from '@higgsfield-mcp/config';
import { expectIssues, makeTempDir } from './helpers.js';

describe('parseGlobalFlags', () => {
  it('separates positionals from flags', () => {
    const parsed = parseGlobalFlags(['serve', '--transport', 'http', '--port', '3001']);
    expect(parsed.positionals).toEqual(['serve']);
    expect(parsed.flags).toEqual({ transport: 'http', port: 3001 });
  });

  it('accepts --flag=value and stops flag parsing at --', () => {
    const parsed = parseGlobalFlags(['--port=3002', '--', '--port', '9999']);
    expect(parsed.flags).toEqual({ port: 3002 });
    expect(parsed.positionals).toEqual(['--port', '9999']);
  });

  it('lets the last occurrence win', () => {
    const parsed = parseGlobalFlags(['--port', '3001', '--port', '3003']);
    expect(parsed.flags.port).toBe(3003);
  });

  it('rejects an unknown flag', () => {
    expectIssues(() => parseGlobalFlags(['--bogus']), ['cli.--bogus']);
  });

  it('rejects a flag with no value', () => {
    expectIssues(() => parseGlobalFlags(['--config']), ['cli.--config']);
  });

  it('collects every flag problem at once', () => {
    expectIssues(() => parseGlobalFlags(['--port', 'nope', '--wat', '--transport', 'carrier-pigeon']), [
      'cli.--port',
      'cli.--transport',
      'cli.--wat'
    ]);
  });

  it('rejects non-integer, negative, and out-of-range ports', () => {
    expectIssues(() => parseGlobalFlags(['--port', '3000.5']), ['cli.--port']);
    expectIssues(() => parseGlobalFlags(['--port', '-1']), ['cli.--port']);
    expectIssues(() => parseGlobalFlags(['--port', '70000']), ['cli.--port']);
  });

  it('rejects an unknown transport', () => {
    expectIssues(() => parseGlobalFlags(['--transport', 'carrier-pigeon']), ['cli.--transport']);
  });
});

describe('loadConfig with CLI flags', () => {
  it('applies flags to the resolved configuration', () => {
    const config = loadConfig({ argv: ['serve', '--host', '0.0.0.0', '--port', '3004'], env: {}, cwd: makeTempDir() });
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.port).toBe(3004);
  });

  it('fails on an unknown flag instead of ignoring it', () => {
    expectIssues(() => loadConfig({ argv: ['--transportt', 'http'], env: {}, cwd: makeTempDir() }), ['cli.--transportt']);
  });
});
