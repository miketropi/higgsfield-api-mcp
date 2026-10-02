import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadConfigFile } from '@higgsfield-mcp/config';
import { expectIssues, makeTempDir, writeJsonFile } from './helpers.js';

describe('loadConfigFile', () => {
  it('returns the validated JSON object', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'gateway.json', { server: { port: 4321 }, media: { allowedPaths: ['/workspace', '/data'] } });
    expect(loadConfigFile(path)).toEqual({ server: { port: 4321 }, media: { allowedPaths: ['/workspace', '/data'] } });
  });

  it('rejects unknown top-level and nested keys', () => {
    const cwd = makeTempDir();
    const root = writeJsonFile(cwd, 'root.json', { telemetry: true });
    const nested = writeJsonFile(cwd, 'nested.json', { server: { prot: 3000 } });
    expectIssues(() => loadConfigFile(root), ['(root)']);
    expectIssues(() => loadConfigFile(nested), ['server']);
  });

  it('rejects malformed JSON and unreadable files', () => {
    const cwd = makeTempDir();
    writeFileSync(`${cwd}/broken.json`, '{ "server": ', 'utf8');
    expectIssues(() => loadConfigFile('/nonexistent/does-not-exist.json'), ['config file']);
    expectIssues(() => loadConfigFile(`${cwd}/broken.json`), ['config file']);
  });

  it('rejects secret values carried in a config file', () => {
    const cwd = makeTempDir();
    const credentials = writeJsonFile(cwd, 'creds.json', { provider: { credentials: 'Key a:b' } });
    const database = writeJsonFile(cwd, 'db.json', { persistence: { databaseUrl: 'postgres://u:p@h/db' } });
    const key = writeJsonFile(cwd, 'key.json', { dataEncryptionKey: 'AAAA' });
    expectIssues(() => loadConfigFile(credentials), ['provider.credentials']);
    expectIssues(() => loadConfigFile(database), ['persistence.databaseUrl']);
    expectIssues(() => loadConfigFile(key), ['dataEncryptionKey']);
  });

  it('rejects wildcards and unsafe media paths', () => {
    const cwd = makeTempDir();
    const wildcardHosts = writeJsonFile(cwd, 'hosts.json', { server: { allowedHosts: ['*'] } });
    const wildcardOrigins = writeJsonFile(cwd, 'origins.json', { server: { allowedOrigins: ['*'] } });
    const relative = writeJsonFile(cwd, 'relative.json', { media: { allowedPaths: ['workspace'] } });
    const traversal = writeJsonFile(cwd, 'traversal.json', { media: { allowedPaths: ['/workspace/../etc'] } });
    expectIssues(() => loadConfig({ argv: ['--config', wildcardHosts], env: {}, cwd }), ['server.allowedHosts']);
    expectIssues(() => loadConfig({ argv: ['--config', wildcardOrigins], env: {}, cwd }), ['server.allowedOrigins']);
    expectIssues(() => loadConfig({ argv: ['--config', relative], env: {}, cwd }), ['media.allowedPaths']);
    expectIssues(() => loadConfig({ argv: ['--config', traversal], env: {}, cwd }), ['media.allowedPaths']);
  });

  it('reports an unreadable config path through loadConfig', () => {
    const cwd = makeTempDir();
    expectIssues(() => loadConfig({ argv: ['--config', `${cwd}/missing.json`], env: {}, cwd }), ['config file']);
  });

  it('accepts arrays as JSON arrays, not comma strings', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'arrays.json', { server: { allowedHosts: ['a.example', 'b.example'] }, media: { allowedPaths: ['/workspace'] } });
    const config = loadConfig({ argv: ['--config', path], env: {}, cwd });
    expect(config.server.allowedHosts).toEqual(['a.example', 'b.example']);
    expect(config.media.allowedPaths).toEqual(['/workspace']);
  });

  it('accepts an absolute model aliases path and rejects a relative one', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'models.json', { models: { aliasesFile: '/etc/higgsfield/aliases.json' } });
    const relative = writeJsonFile(cwd, 'models-relative.json', { models: { aliasesFile: 'aliases.json' } });
    expect(loadConfig({ argv: ['--config', path], env: {}, cwd }).models.aliasesFile).toBe('/etc/higgsfield/aliases.json');
    expectIssues(() => loadConfig({ argv: ['--config', relative], env: {}, cwd }), ['models.aliasesFile']);
  });

  it('accepts a rate limits file path from a config file', () => {
    const cwd = makeTempDir();
    const path = writeJsonFile(cwd, 'limits.json', { limits: { rateLimitsFile: '/etc/higgsfield/limits.json' } });
    expect(loadConfig({ argv: ['--config', path], env: {}, cwd }).limits.rateLimitsFile).toBe('/etc/higgsfield/limits.json');
  });
});
