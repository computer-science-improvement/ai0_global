import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { pgDbName, pgWithDb } from '../../../common/testing/pg-test-url';

/**
 * Spec 055 PG tests: a throwaway database next to EDITOR_PG_TEST_URL with init.sql and every migration applied (the way
 * database/migrate.sh does, one transaction per file). `drop()` removes it. Never point this at a real database.
 */
const DB_DIR = join(__dirname, '..', '..', '..', '..', '..', '..', 'database');

export interface FreshDb { pool: Pool; url: string; name: string; drop(): Promise<void> }

export async function createMigratedDb(baseUrl: string, suffix: string): Promise<FreshDb> {
  const name = `${pgDbName(baseUrl)}_${suffix}_${process.pid}`.toLowerCase();
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
    for (const f of readdirSync(join(DB_DIR, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query('BEGIN');
      try { await c.query(readFileSync(join(DB_DIR, 'migrations', f), 'utf8')); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw new Error(`${f}: ${(e as Error).message}`); }
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
