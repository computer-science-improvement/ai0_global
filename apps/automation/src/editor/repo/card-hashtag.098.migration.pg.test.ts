/**
 * Migration 098 (spec 073 FR-013, A37): `editor_channels.hashtag_min` DEFAULT 0, and a channel with no hashtag vocabulary and a
 * minimum above 0 is set to 0. Creates its own database next to EDITOR_PG_TEST_URL (init.sql + every migration except 098; 097
 * is another spec's and may be absent), inserts two channels with `hashtag_min` 1 (one with no hashtags, one with a vocabulary),
 * applies 098 and checks the backfill, the column default and a raw INSERT; a second apply changes nothing; the down file
 * (applied twice) restores DEFAULT 1, removes the `schema_migrations` row and leaves the values alone. Skipped unless
 * EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { pgDbName, pgWithDb } from '../../common/testing/pg-test-url';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');
const M098 = readFileSync(join(MIGRATIONS, '098_card_hashtag_default.sql'), 'utf8');
const D098 = readFileSync(join(MIGRATIONS, 'down', '098_card_hashtag_default.down.sql'), 'utf8');
const NONE = '@pgt098_none';
const TAGGED = '@pgt098_tagged';

let admin: Client;
let pool: Pool;
let dbName: string;

async function applyFile(sql: string) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const hashtagMin = async (key: string): Promise<number> => (await pool.query(`SELECT hashtag_min FROM editor_channels WHERE channel_key = $1`, [key])).rows[0].hashtag_min;
const columnDefault = async (): Promise<string> =>
  (await pool.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'editor_channels' AND column_name = 'hashtag_min'`)).rows[0].column_default;
const recorded = async (): Promise<boolean> => (await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '098_card_hashtag_default'`)).rows.length === 1;

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${pgDbName(url)}_m098_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new Client({ connectionString: pgWithDb(url, dbName) });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      if (f.startsWith('098')) continue;
      await c.query('BEGIN');
      try { await c.query(readFileSync(join(MIGRATIONS, f), 'utf8')); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.end();
  }
  pool = new Pool({ connectionString: pgWithDb(url, dbName), max: 4 });
});

after(async () => {
  if (!url) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  await admin.end();
});

test('before 098 the default is 1 (042), so a channel made with no vocabulary demands a hashtag', { skip }, async () => {
  assert.equal(await columnDefault(), '1');
  assert.equal(await recorded(), false);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, hashtags, hashtag_min) VALUES ($1, 'approve', '{}', 1), ($2, 'approve', '{ai,ml}', 1)`, [NONE, TAGGED]);
  assert.deepEqual([await hashtagMin(NONE), await hashtagMin(TAGGED)], [1, 1]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@pgt098_raw_before', 'approve')`);
  assert.equal(await hashtagMin('@pgt098_raw_before'), 1, 'a raw INSERT gets the old default');
});

test('098: the channel with no hashtags goes to 0, the one with a vocabulary keeps 1, the default is 0, and it records itself', { skip }, async () => {
  await applyFile(M098);
  assert.equal(await hashtagMin(NONE), 0);
  assert.equal(await hashtagMin(TAGGED), 1);
  assert.equal(await columnDefault(), '0');
  assert.equal(await recorded(), true);
  assert.equal(await hashtagMin('@pgt098_raw_before'), 0, 'the channel made earlier with no hashtags is backfilled too');
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@pgt098_raw_after', 'approve')`);
  assert.equal(await hashtagMin('@pgt098_raw_after'), 0, 'a raw INSERT without the column gets 0');
  // The table's own check still holds: the minimum never exceeds the maximum.
  const bad = await pool.query(`UPDATE editor_channels SET hashtag_min = 5, hashtag_max = 2 WHERE channel_key = $1`, [TAGGED]).then(() => 'accepted', () => 'refused');
  assert.equal(bad, 'refused');
});

test('a second apply changes nothing: the vocabulary channel keeps its minimum, nothing is recorded twice', { skip }, async () => {
  await applyFile(M098);
  assert.deepEqual([await hashtagMin(NONE), await hashtagMin(TAGGED)], [0, 1]);
  assert.equal(await columnDefault(), '0');
  assert.equal((await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '098_card_hashtag_default'`)).rows.length, 1);
});

test('down, applied twice: the default is 1 again, the row is gone, the values are unchanged', { skip }, async () => {
  await applyFile(D098);
  await applyFile(D098);
  assert.equal(await columnDefault(), '1');
  assert.equal(await recorded(), false);
  assert.deepEqual([await hashtagMin(NONE), await hashtagMin(TAGGED)], [0, 1], 'the backfill is not undone');
  // Up again after the down: the same end state.
  await applyFile(M098);
  assert.equal(await columnDefault(), '0');
  assert.equal(await recorded(), true);
});
