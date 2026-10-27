/**
 * Migration 096 (dataset rounds, spec 071) on a database of its own (init.sql + every migration): the down file puts the
 * 060 / 083 function bodies and both CHECKs back and removes the rounds, the triggers and the `passed` rows; 096 applies
 * again on top, and a second time (CI re-applies it). Creates its own database next to EDITOR_PG_TEST_URL and drops it;
 * the down file never runs against the shared database. Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';
import { ContentLedger } from './content-ledger';
import { DataStore } from './data-store';
import { createMigratedDb, type FreshDb } from '../editor/sysadmin/testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATIONS = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
const UP = readFileSync(join(MIGRATIONS, '096_data_reuse_rounds.sql'), 'utf8');
const DOWN = readFileSync(join(MIGRATIONS, 'down', '096_data_reuse_rounds.down.sql'), 'utf8');
const RES = 'telegram:@pgt071m_a';

let db: FreshDb;
let pool: Pool;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'm096');
  pool = db.pool;
});
after(async () => { await db?.drop(); });

async function apply(sql: string) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const fn = async (name: string) => (await pool.query(`SELECT provolatile, prosrc, pronargs FROM pg_proc WHERE proname = $1`, [name])).rows;
const checkDef = async (table: string, like: string) =>
  (await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE $2`, [table, like])).rows;

test('096 leaves the cycle machinery in place, one function per name, final bodies', { skip }, async () => {
  for (const name of ['content_ledger_blocks', 'content_ledger_blocking', 'content_ledger_used', 'data_schema_stats_refresh', 'content_ledger_record']) {
    assert.equal((await fn(name)).length, 1, `${name} has a single overload`);
  }
  assert.equal((await fn('content_ledger_blocks'))[0].provolatile, 's', 'content_ledger_blocks is STABLE');
  assert.match((await fn('content_ledger_blocking'))[0].prosrc, /content_ref_reuse_at/);
  assert.match((await fn('content_ledger_used'))[0].prosrc, /data_reuse_rounds/);
  assert.match((await fn('data_schema_stats_refresh'))[0].prosrc, /content_reuse_at/, 'the round-aware 083 body (083 is in place here)');
  assert.match((await fn('data_schema_stats_refresh'))[0].prosrc, /rows_unpostable/);
  assert.equal((await pool.query(`SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_content_ledger_round', 'trg_data_schemas_reuse_round')`)).rowCount, 2);
  assert.equal((await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '096_data_reuse_rounds'`)).rowCount, 1);
});

test('the down file restores the 060 / 083 bodies and both CHECKs, drops rounds, triggers and passed rows; 096 applies again', { skip }, async () => {
  // State to lose: a cycle dataset with a round and a passed row.
  const store = new DataStore(pool);
  const ledger = new ContentLedger(pool);
  await store.createSchema({
    key: 'pgt071m_rows', title: 'rows', description: 'x', entity: 'item', fields: [{ name: 'num', type: 'int', description: 'n', required: true }],
    roles: { title: 'num' }, dedup_key: ['num'], language: 'uk', default_license: 'own', reuse_policy: { kind: 'cycle', order: 'random' },
    suitable_for: 'tests', contains_personal_data: false, status: 'active',
  } as any, 'pgtest');
  await store.upsert('pgt071m_rows', [{ num: 1 }, { num: 2 }]);
  const ids = (await pool.query(`SELECT d.id::text AS id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = 'pgt071m_rows' ORDER BY d.id`)).rows.map((r) => r.id);
  await ledger.record(`data://pgt071m_rows/${ids[0]}`, { resourceRef: RES, origin: 'editor', status: 'published' });
  await ledger.pass(`data://pgt071m_rows/${ids[1]}`, { resourceRef: RES });
  assert.equal((await pool.query(`SELECT round FROM data_reuse_rounds`)).rows[0].round, 2);

  await apply(DOWN);

  assert.equal((await pool.query(`SELECT to_regclass('data_reuse_rounds') AS t`)).rows[0].t, null, 'the rounds table is gone');
  for (const name of ['data_round_roll', 'content_ledger_pass', 'content_reuse_at', 'content_ref_reuse_at', 'data_reuse_policy_valid', 'content_ledger_round_after', 'data_schemas_reuse_round_after']) {
    assert.equal((await fn(name)).length, 0, `${name} is gone`);
  }
  assert.equal((await pool.query(`SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_content_ledger_round', 'trg_data_schemas_reuse_round')`)).rowCount, 0);
  const blocks = (await fn('content_ledger_blocks'))[0];
  assert.equal(blocks.provolatile, 'i', '060: IMMUTABLE again');
  assert.doesNotMatch(blocks.prosrc, /cycle|passed/);
  assert.match((await fn('content_ledger_blocking'))[0].prosrc, /content_ref_reuse\(l\.source_ref\)/);
  assert.doesNotMatch((await fn('content_ledger_used'))[0].prosrc, /data_reuse_rounds|content_reuse_at/);
  const stats = (await fn('data_schema_stats_refresh'))[0].prosrc;
  assert.match(stats, /rows_unpostable/, '083 body (the column exists)');
  assert.doesNotMatch(stats, /content_reuse_at/);
  assert.equal((await fn('data_schema_stats_refresh')).length, 1);
  assert.equal((await fn('content_ledger_blocks')).length, 1, 'one overload per ledger function');
  assert.equal((await fn('content_ledger_used')).length, 1);
  assert.equal((await fn('content_ledger_blocking')).length, 1);

  const policy = (await checkDef('data_schemas', '%reuse_policy%'));
  assert.equal(policy.length, 1);
  assert.match(policy[0].def, /never/);
  assert.doesNotMatch(policy[0].def, /data_reuse_policy_valid|cycle/);
  const status = await checkDef('content_ledger', '%shadowed%');
  assert.equal(status.length, 1);
  assert.doesNotMatch(status[0].def, /passed/);
  assert.equal((await checkDef('content_ledger', '%anchor%')).length, 1, '094 anchor CHECK untouched');

  assert.equal((await pool.query(`SELECT reuse_policy FROM data_schemas WHERE key = 'pgt071m_rows'`)).rows[0].reuse_policy.kind, 'never', 'cycle datasets became never');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM content_ledger WHERE status = 'passed'`)).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '096_data_reuse_rounds'`)).rowCount, 0);
  await assert.rejects(pool.query(`UPDATE data_schemas SET reuse_policy = '{"kind":"cycle"}' WHERE key = 'pgt071m_rows'`), /data_schemas_reuse_policy_check/);
  await assert.rejects(pool.query(`INSERT INTO content_ledger (resource_ref, source_ref, origin, status) VALUES ('x', 'y', 'editor', 'passed')`), /content_ledger_status_check/);
  await pool.query(`SELECT data_schema_stats_refresh()`);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM content_ledger_used($1)`, [RES])).rows[0].n, 1, 'the old rules: the published row blocks for ever');

  // 096 applies again on the reverted schema, and a second time (CI re-applies migrations).
  await apply(UP);
  await apply(UP);
  assert.equal((await fn('content_ledger_blocks')).length, 1);
  assert.equal((await fn('content_ledger_blocks'))[0].provolatile, 's');
  assert.equal((await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '096_data_reuse_rounds'`)).rowCount, 1);
  assert.equal((await checkDef('data_schemas', '%reuse_policy%')).length, 1, 'still exactly one CHECK on the policy');
  assert.equal((await checkDef('content_ledger', '%shadowed%')).length, 1);
  // The machinery works again: the published row is done in round 1, the row whose passed mark went with the down file is open.
  await pool.query(`UPDATE data_schemas SET reuse_policy = '{"kind":"cycle","order":"sequential"}' WHERE key = 'pgt071m_rows'`);
  assert.equal((await pool.query(`SELECT 1 FROM data_reuse_rounds`)).rowCount, 0, 'round 1 goes on');
  assert.deepEqual((await pool.query(`SELECT ref FROM content_ledger_used($1)`, [RES])).rows.map((r) => r.ref), [`data://pgt071m_rows/${ids[0]}`]);
  await ledger.record(`data://pgt071m_rows/${ids[1]}`, { resourceRef: RES, origin: 'editor', status: 'published' });
  assert.equal((await pool.query(`SELECT round FROM data_reuse_rounds`)).rows[0].round, 2, 'the last row rolled it');
});
