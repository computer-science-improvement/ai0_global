/**
 * A throwaway database for the loadout PG tests (spec 054): created next to EDITOR_PG_TEST_URL, init.sql plus every
 * migration applied in order, dropped at the end. One database per test file (`name`), so tests never touch the shared
 * one. Never point EDITOR_PG_TEST_URL at a real database.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { pgWithDb } from '../../../common/testing/pg-test-url';

const DB_DIR = join(__dirname, '..', '..', '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');

export interface LoadoutDb {
  pool: Pool;
  drop(): Promise<void>;
}

export async function createLoadoutDb(url: string, name: string): Promise<LoadoutDb> {
  const dbName = `t054_${name}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: pgWithDb(url, dbName) });
  try {
    await pool.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
  } catch (err) {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
    await admin.end();
    throw err;
  }
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
      await admin.end();
    },
  };
}
