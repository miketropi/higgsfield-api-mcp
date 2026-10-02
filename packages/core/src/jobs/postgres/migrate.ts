/**
 * Versioned migration runner (SPEC §40, §51).
 *
 * `higgsfield-mcp migrate` is the only supported way to create schema; the
 * repository never runs DDL implicitly at startup, so a rolling deploy cannot race
 * itself into a half-applied schema.
 *
 * Guarantees
 * - One session-level PostgreSQL advisory lock for the whole run, so concurrent
 *   replicas serialise instead of racing DDL.
 * - Each migration file runs inside its own transaction, together with the
 *   `schema_migrations` row that records it: either both land or neither does.
 * - Re-running is a no-op for already-applied files (recorded by filename).
 * - A failure aborts the run, rolls back that migration, and names the file.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { GatewayError } from '../../errors.js';
import type { LoggerPort } from '../../contracts.js';
import type { SqlRow } from './mapping.js';

export interface RunMigrationsOptions {
  connectionString: string;
  logger: LoggerPort;
  /** Defaults to the migrations directory shipped next to this module. */
  migrationsDir?: string;
}

/** Stable advisory-lock key for "higgsfield-mcp migrations". */
const MIGRATION_LOCK_KEY = 7_312_009_118_042_113;

const MIGRATIONS_TABLE = 'schema_migrations';
const CONNECT_TIMEOUT_MS = 10_000;

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Candidate locations for the packaged migrations, in order: an explicit
 * `migrationsDir`, then the layouts produced by `tsup` (flat `dist/migrations` or
 * a preserved `dist/jobs/postgres/migrations`) and finally the source tree, so the
 * runner works from source, from a bundled CLI and from a container image.
 */
async function resolveMigrationsDir(configured: string | undefined): Promise<string> {
  const candidates =
    configured === undefined
      ? [
          path.join(moduleDir(), 'migrations'),
          path.join(moduleDir(), 'jobs', 'postgres', 'migrations'),
          path.join(moduleDir(), '..', 'jobs', 'postgres', 'migrations'),
          path.join(moduleDir(), '..', 'src', 'jobs', 'postgres', 'migrations')
        ]
      : [configured];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new GatewayError('INTERNAL_ERROR', 'Migrations directory was not found.', {
    details: { component: 'migrations', configured: configured !== undefined, candidates: candidates.length }
  });
}

async function rowsOf(client: Client, sql: string, values?: unknown[]): Promise<SqlRow[]> {
  const result = await client.query(sql, values);
  return result.rows as SqlRow[];
}

function driverCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) return String(error.code);
  return undefined;
}

export async function runMigrations(options: RunMigrationsOptions): Promise<{ applied: string[] }> {
  const { connectionString, logger } = options;
  const directory = await resolveMigrationsDir(options.migrationsDir);
  const files = (await readdir(directory)).filter((entry) => entry.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new GatewayError('INTERNAL_ERROR', 'No migration files were found.', {
      details: { component: 'migrations' }
    });
  }

  const client = new Client({
    connectionString,
    application_name: 'higgsfield-mcp-migrate',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS
  });
  await client.connect();
  const applied: string[] = [];
  try {
    // Session-level lock: held across every per-file transaction of this run.
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         filename text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const recorded = await rowsOf(client, `SELECT filename FROM ${MIGRATIONS_TABLE}`);
    const alreadyApplied = new Set<string>();
    for (const row of recorded) {
      const filename = row['filename'];
      if (typeof filename === 'string') alreadyApplied.add(filename);
    }

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(path.join(directory, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The connection is already unusable; the run aborts either way.
        }
        throw new GatewayError('INTERNAL_ERROR', `Migration ${file} failed and was rolled back.`, {
          details: { component: 'migrations', file, driverCode: driverCode(error) },
          cause: error
        });
      }
      applied.push(file);
      logger.info({ component: 'migrations', event: 'migration_applied', file }, 'applied migration');
    }
    return { applied };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
    } catch {
      // The session is closing; the lock dies with it.
    }
    await client.end();
  }
}
