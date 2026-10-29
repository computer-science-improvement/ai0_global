import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { pgDbName, pgWithDb } from '../../../common/testing/pg-test-url';

/**
 * Spec 072 PG tests (A14): a throwaway database of its own next to EDITOR_PG_TEST_URL, with `schema_migrations`, init.sql and every
 * migration applied in order (one transaction per file, as database/migrate.sh does). The database is named
 * `<base>_m097_<tag>_<pid>`, so no other agent or file shares it, and `drop()` removes it. Never point this at a real database.
 *
 * `o.skip(file)` leaves a migration out (a test that needs the state before one of them). Callers skip the test when the URL is unset.
 */
const DB_DIR = join(__dirname, '..', '..', '..', '..', '..', '..', 'database');
export const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

export interface ScratchDb { pool: Pool; url: string; name: string; drop(): Promise<void> }

export async function scratchDb(baseUrl: string, tag: string, o: { skip?: (file: string) => boolean } = {}): Promise<ScratchDb> {
  const name = `${pgDbName(baseUrl)}_m097_${tag}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = pgWithDb(baseUrl, name);
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      if (o.skip?.(f)) continue;
      await c.query('BEGIN');
      try { await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw Object.assign(new Error(`${f}: ${(e as Error).message}`), { cause: e }); }
    }
  } finally {
    await c.end();
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  return {
    pool, url, name,
    async drop() {
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    },
  };
}

/** One migration or down file, read as text. */
export const readMigration = (file: string): string => readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
export const readDown = (file: string): string => readFileSync(join(MIGRATIONS_DIR, 'down', file), 'utf8');

/** Applies a file in one transaction. */
export async function applySql(pool: Pool, sql: string): Promise<void> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
