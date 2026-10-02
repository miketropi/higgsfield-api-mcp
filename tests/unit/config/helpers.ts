import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { ConfigValidationError } from '@higgsfield-mcp/config';

/** Fresh temp directory per call; callers pass it as `cwd` so nothing touches process state. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hf-config-test-'));
}

/** Writes JSON to `<dir>/<name>` and returns the absolute path. */
export function writeJsonFile(dir: string, name: string, data: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}

/** Reads a dotted path out of a loaded config object. */
export function getPath(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Runs `fn`, returning the issue paths from the thrown `ConfigValidationError`. */
export function issuePaths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.issues.map((issue) => issue.path).sort();
    throw error;
  }
  throw new Error('expected ConfigValidationError, but the call succeeded');
}

/** Asserts the exact set of failing config paths. */
export function expectIssues(fn: () => unknown, expectedPaths: string[]): void {
  expect(issuePaths(fn)).toEqual([...expectedPaths].sort());
}

/** A base64 key that decodes to exactly 32 bytes. */
export const VALID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** Environment that satisfies every remote-mode requirement. */
export const REMOTE_ENV: Record<string, string> = {
  HF_MCP_TRANSPORT: 'http',
  HF_MCP_DATABASE_URL: 'postgres://gateway:pw@db.internal:5432/gateway',
  HF_MCP_REDIS_URL: 'redis://cache.internal:6379',
  HF_MCP_DATA_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
  HF_MCP_AUTH_MODE: 'static_token',
  HF_MCP_TENANTS_FILE: '/etc/higgsfield/tenants.json',
  HF_MCP_PROVIDER_ACCOUNT_ID: 'acct-remote'
};
