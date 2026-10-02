/**
 * Support for the reliability integration suites.
 *
 * The suites run against disposable services only, addressed through
 * `HF_MCP_TEST_DATABASE_URL` and `HF_MCP_TEST_REDIS_URL`; when a URL is absent the
 * suite skips with a clear message instead of silently passing.
 *
 * Every PostgreSQL suite works in its own freshly created schema, so suites never
 * share tables and a repeated run starts from an empty schema (the migration path
 * itself is what provisions it).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { LoggerPort } from '@higgsfield-mcp/core';

export const TEST_DATABASE_URL = process.env['HF_MCP_TEST_DATABASE_URL'];
export const TEST_REDIS_URL = process.env['HF_MCP_TEST_REDIS_URL'];

export function announceSkip(suite: string, variable: string): void {
  process.stdout.write(`[reliability] ${variable} is not set — skipping ${suite}.\n`);
}

export function uniqueSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

/** Silent `LoggerPort`: the adapter's logs are not the subject of these tests. */
export function silentLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger
  };
  return logger;
}

export interface TestSchema {
  schema: string;
  /** Connection string whose sessions default to the isolated schema. */
  connectionString: string;
  dispose: () => Promise<void>;
}

/**
 * Creates an isolated schema and returns a connection string bound to it via the
 * libpq `options=-c search_path=…` startup parameter, so no adapter code needs to
 * know about test isolation.
 */
export async function createTestSchema(baseUrl: string): Promise<TestSchema> {
  const schema = `hf_test_${uniqueSuffix()}`;
  if (!/^[a-z0-9_]+$/.test(schema)) throw new Error('Generated schema name is not identifier-safe.');
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const separator = baseUrl.includes('?') ? '&' : '?';
  const connectionString = `${baseUrl}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  return {
    schema,
    connectionString,
    async dispose() {
      const dropper = new Client({ connectionString: baseUrl });
      await dropper.connect();
      try {
        await dropper.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await dropper.end();
      }
    }
  };
}

/**
 * Narrows a driver result's rows to JSON objects. The single narrowing point for
 * raw query results used by the suites.
 */
export function rowsOf(result: { rows: unknown[] }): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const row of result.rows) {
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>);
  }
  return rows;
}

export function firstRow(result: { rows: unknown[] }): Record<string, unknown> {
  const row = rowsOf(result)[0];
  if (row === undefined) throw new Error('Expected at least one row.');
  return row;
}

/** Opens a raw client on a connection string; used to inspect stored columns. */
export async function rawClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}
