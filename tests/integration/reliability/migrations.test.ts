/**
 * Migration runner contract, against a disposable database
 * (`HF_MCP_TEST_DATABASE_URL`). Each test provisions (and drops) its own schema, so
 * the "applies once" and "two replicas migrate concurrently" cases are genuinely
 * exercised rather than being no-ops on an already-migrated database.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@higgsfield-mcp/core';
import type { LoggerPort } from '@higgsfield-mcp/core';
import {
  TEST_DATABASE_URL,
  announceSkip,
  createTestSchema,
  firstRow,
  rawClient,
  rowsOf,
  silentLogger
} from './support/services.js';
import type { TestSchema } from './support/services.js';

const SUITE = 'PostgreSQL migrations';
if (TEST_DATABASE_URL === undefined) announceSkip(SUITE, 'HF_MCP_TEST_DATABASE_URL');

describe.skipIf(TEST_DATABASE_URL === undefined)(SUITE, () => {
  let logger: LoggerPort;
  const schemas: TestSchema[] = [];

  beforeAll(() => {
    logger = silentLogger();
  });

  afterAll(async () => {
    await Promise.all(schemas.splice(0).map((schema) => schema.dispose()));
  });

  async function freshSchema(): Promise<TestSchema> {
    if (TEST_DATABASE_URL === undefined) throw new Error('HF_MCP_TEST_DATABASE_URL is required');
    const schema = await createTestSchema(TEST_DATABASE_URL);
    schemas.push(schema);
    return schema;
  }

  it('applies every migration once and is a no-op on the second run', async () => {
    const schema = await freshSchema();

    const first = await runMigrations({ connectionString: schema.connectionString, logger });
    expect(first.applied).toContain('0001_init.sql');

    const second = await runMigrations({ connectionString: schema.connectionString, logger });
    expect(second.applied).toEqual([]);

    const client = await rawClient(schema.connectionString);
    try {
      const rows = rowsOf(await client.query('SELECT filename FROM schema_migrations ORDER BY filename'));
      expect(rows.map((row) => row['filename'])).toEqual(['0001_init.sql']);
      const tables = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`
      );
      const names = rowsOf(tables).map((row) => row['table_name']);
      expect(names).toEqual(
        expect.arrayContaining([
          'assets',
          'audit_events',
          'confirmations',
          'idempotency_keys',
          'jobs',
          'schema_migrations',
          'submissions',
          'usage_events',
          'usage_reservations'
        ])
      );
      const indexRows = rowsOf(
        await client.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()')
      );
      const indexNames = indexRows.map((row) => String(row['indexname']));
      expect(indexNames).toEqual(
        expect.arrayContaining([
          'jobs_tenant_created_idx',
          'jobs_provider_job_id_idx',
          'assets_tenant_created_idx',
          'idempotency_keys_pkey',
          'submissions_pkey',
          'submissions_claim_idx',
          'submissions_provider_job_id_idx',
          'submissions_callback_token_hash_idx',
          'usage_reservations_pkey',
          'usage_reservations_tenant_day_idx'
        ])
      );
      const callbackIndex = indexRows.find((row) => row['indexname'] === 'submissions_callback_token_hash_idx');
      // Unique, and partial: a NULL hash (no callback token) must not collide.
      expect(String(callbackIndex?.['indexdef'])).toContain('UNIQUE');
      expect(String(callbackIndex?.['indexdef'])).toContain('WHERE');
    } finally {
      await client.end();
    }
  });

  it('lets two concurrent replicas migrate the same schema without failing', async () => {
    const schema = await freshSchema();

    const [first, second] = await Promise.all([
      runMigrations({ connectionString: schema.connectionString, logger }),
      runMigrations({ connectionString: schema.connectionString, logger })
    ]);

    const union = [...new Set([...first.applied, ...second.applied])];
    expect(union).toEqual(['0001_init.sql']);
    // The advisory lock serialises the runs: exactly one of them applied the file.
    expect([first.applied.length, second.applied.length].sort()).toEqual([0, 1]);

    const client = await rawClient(schema.connectionString);
    try {
      const row = firstRow(await client.query('SELECT count(*)::int AS applied FROM schema_migrations'));
      expect(row['applied']).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('reports a failing migration by filename and rolls it back', async () => {
    const schema = await freshSchema();
    const directory = await mkdtemp(path.join(tmpdir(), 'hf-migrations-'));
    try {
      await writeFile(path.join(directory, '0001_broken.sql'), 'CREATE TABLE broken (id text PRIMARY KEY);\n', 'utf8');
      await writeFile(
        path.join(directory, '0002_invalid.sql'),
        'CREATE TABLE also_broken (id text PRIMARY KEY REFERENCES table_that_does_not_exist (id));\n',
        'utf8'
      );

      const failure = await runMigrations({
        connectionString: schema.connectionString,
        logger,
        migrationsDir: directory
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: 'INTERNAL_ERROR',
        details: { component: 'migrations', file: '0002_invalid.sql' }
      });

      const client = await rawClient(schema.connectionString);
      try {
        const rows = rowsOf(await client.query('SELECT filename FROM schema_migrations ORDER BY filename'));
        // 0001 committed; 0002 rolled back and is not recorded.
        expect(rows.map((row) => row['filename'])).toEqual(['0001_broken.sql']);
      } finally {
        await client.end();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a configured migrations directory that does not exist', async () => {
    const schema = await freshSchema();
    await expect(
      runMigrations({
        connectionString: schema.connectionString,
        logger,
        migrationsDir: path.join(tmpdir(), 'hf-missing-migrations-directory')
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', details: { component: 'migrations' } });
  });
});
