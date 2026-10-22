/**
 * Spec 064 FR-001 against a throwaway Postgres: two rollups started in the same instant (the five-minute job and the
 * midnight cron) no longer collide on uq_llm_usage_daily. Only llm_usage and llm_usage_daily are created, from the
 * 056 migration's own DDL. Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { LlmUsageRollup } from './llm-usage-rollup';
import { pgDbName, pgWithDb } from '../../testing/pg-test-url';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'database', 'migrations', '056_llm_usage.sql'), 'utf8');

let admin: Client;
let pool: Pool;
let dbName: string;

/** The DDL of one table (and its indexes) out of the 056 migration, between two markers. */
function slice(from: string, to: string): string {
  const a = MIGRATION.indexOf(from);
  const b = MIGRATION.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers ${from} … ${to} found in 056`);
  return MIGRATION.slice(a, b);
}

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${pgDbName(url)}_r064_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new Pool({ connectionString: pgWithDb(url, dbName), max: 4 });
  // llm_usage references agents and editor_runs; the rollup does not need either.
  await pool.query(`CREATE TABLE agents (id UUID PRIMARY KEY); CREATE TABLE editor_runs (id UUID PRIMARY KEY)`);
  await pool.query(slice('CREATE TABLE IF NOT EXISTS llm_usage (', 'CREATE TABLE IF NOT EXISTS llm_prices'));
  await pool.query(slice('CREATE TABLE IF NOT EXISTS llm_usage_daily', '-- scope_kind'));
});
after(async () => {
  if (!url) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

test('two rollups at the same instant both succeed and leave one row per key', { skip }, async () => {
  await pool.query(
    `INSERT INTO llm_usage (at, provider, model, feature, tokens_in, tokens_out, cost_usd, cost_source, status)
     SELECT now(), 'openrouter', 'm' || (g % 3), 'pgt064.f', 10, 1, 0.01, 'provider', 'ok' FROM generate_series(1, 300) g`);
  const a = new LlmUsageRollup(pool);
  const b = new LlmUsageRollup(pool);
  for (let round = 0; round < 5; round++) {
    const res = await Promise.allSettled([a.rollup(), b.rollup(), a.rollup()]);
    assert.deepEqual(res.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled'], `round ${round}: ${res.map((r) => (r as any).reason?.message).join(' | ')}`);
  }
  const { rows } = await pool.query(`SELECT model, calls FROM llm_usage_daily WHERE feature = 'pgt064.f' ORDER BY model`);
  assert.deepEqual(rows.map((r) => [r.model, r.calls]), [['m0', 100], ['m1', 100], ['m2', 100]]);
});
