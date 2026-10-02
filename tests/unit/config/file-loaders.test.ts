import { describe, expect, it } from 'vitest';
import { loadModelAliasesFile, loadRateLimitsFile } from '@higgsfield-mcp/config';
import { expectIssues, makeTempDir, writeJsonFile } from './helpers.js';

function fileWith(name: string, data: unknown): string {
  return writeJsonFile(makeTempDir(), name, data);
}

describe('loadRateLimitsFile', () => {
  const RULES = {
    global: { limit: 120, windowMs: 60_000 },
    tenant: { default: { limit: 60, windowMs: 60_000 }, byId: { 'tenant-1': { limit: 300, windowMs: 60_000 } } },
    token: { default: { limit: 30, windowMs: 60_000 }, byId: { 'token-1': { limit: 10, windowMs: 1_000 } } },
    tool: { byName: { generate_image: { limit: 30, windowMs: 60_000 }, generate_video: { limit: 5, windowMs: 60_000 } } },
    provider: { default: { limit: 240, windowMs: 60_000 } }
  };

  it('returns the validated structure unchanged', () => {
    expect(loadRateLimitsFile(fileWith('limits.json', RULES))).toEqual(RULES);
  });

  it('allows an empty file', () => {
    expect(loadRateLimitsFile(fileWith('empty.json', {}))).toEqual({});
  });

  it.each([
    ['zero limit', { global: { limit: 0, windowMs: 1_000 } }, 'global.limit'],
    ['fractional limit', { global: { limit: 1.5, windowMs: 1_000 } }, 'global.limit'],
    ['window above one hour', { global: { limit: 10, windowMs: 3_600_001 } }, 'global.windowMs'],
    ['zero window', { token: { default: { limit: 10, windowMs: 0 } } }, 'token.default.windowMs'],
    ['unknown key', { global: { limit: 10, windowMs: 1_000, burst: 2 } }, 'global'],
    ['unknown section', { buckets: {} }, '(root)']
  ])('rejects %s', (_label, data, path) => {
    expectIssues(() => loadRateLimitsFile(fileWith('limits.json', data)), [path]);
  });

  it('validates every rule in a byId map', () => {
    const data = { tool: { byName: { generate_image: { limit: 0, windowMs: 1_000 } } } };
    expectIssues(() => loadRateLimitsFile(fileWith('limits.json', data)), ['tool.byName.generate_image.limit']);
  });
});

describe('loadModelAliasesFile', () => {
  const ALIASES = {
    aliases: { 'fast-image': 'higgsfield/flux-schnell', 'cinematic-video': 'higgsfield/veo-3' },
    pricing: { 'fast-image': { unitMicroUsd: 1_500, source: 'api', asOf: '2026-01-01' } }
  };

  it('returns aliases and pricing', () => {
    expect(loadModelAliasesFile(fileWith('aliases.json', ALIASES))).toEqual(ALIASES);
  });

  it('allows aliases without pricing', () => {
    expect(loadModelAliasesFile(fileWith('aliases.json', { aliases: { a: 'higgsfield/x' } }))).toEqual({
      aliases: { a: 'higgsfield/x' }
    });
  });

  it('rejects an empty alias target', () => {
    expectIssues(() => loadModelAliasesFile(fileWith('aliases.json', { aliases: { a: '' } })), ['aliases.a']);
  });

  it('rejects a non-identifier alias name', () => {
    expectIssues(() => loadModelAliasesFile(fileWith('aliases.json', { aliases: { 'bad name': 'higgsfield/x' } })), [
      'aliases.bad name'
    ]);
  });

  it('rejects negative pricing and unknown keys', () => {
    expectIssues(() => loadModelAliasesFile(fileWith('aliases.json', { aliases: {}, pricing: { a: { unitMicroUsd: -1 } } })), [
      'pricing.a.unitMicroUsd'
    ]);
    expectIssues(() => loadModelAliasesFile(fileWith('aliases.json', { aliases: {}, models: {} })), ['(root)']);
  });

  it('rejects a missing aliases map', () => {
    expectIssues(() => loadModelAliasesFile(fileWith('aliases.json', {})), ['aliases']);
  });
});
