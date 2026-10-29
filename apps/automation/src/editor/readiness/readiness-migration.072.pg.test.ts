/**
 * Migration 097 (channel_readiness, spec 072 FR-005): every migration applies on a fresh scratch database; 097 applies a second
 * time without error and changes nothing; the down file runs twice (idempotent) and takes the table and the ledger row away; up
 * again restores both. Columns, defaults, `applied_hash` nullable. Own database (scratchDb); skipped unless EDITOR_PG_TEST_URL
 * is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applySql, readDown, readMigration, scratchDb, type ScratchDb } from './testing/pg-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const UP = '097_channel_readiness.sql';
const DOWN = '097_channel_readiness.down.sql';

let db: ScratchDb;

const columns = async () => (await db.pool.query(
  `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'channel_readiness' ORDER BY ordinal_position`)).rows;
const recorded = async () => (await db.pool.query(`SELECT 1 FROM schema_migrations WHERE version = '097_channel_readiness'`)).rows.length === 1;
const tableExists = async () => (await db.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'channel_readiness'`)).rows.length === 1;

before(async () => { if (url) db = await scratchDb(url, 'mig'); });
after(async () => { if (db) await db.drop(); });

test('097 is applied with every other migration, with the columns and defaults of the spec', { skip }, async () => {
  assert.equal(await tableExists(), true);
  assert.equal(await recorded(), true);
  const cols = await columns();
  assert.deepEqual(cols.map((c) => c.column_name), ['channel_key', 'findings', 'blockers', 'warnings', 'config_hash', 'applied_hash', 'checked_at', 'notified_at', 'notified_blockers']);
  const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  assert.equal(by.applied_hash.is_nullable, 'YES', 'applied_hash is nullable: 074 writes it, 072 never does');
  assert.equal(by.notified_at.is_nullable, 'YES');
  assert.equal(by.channel_key.is_nullable, 'NO');
  assert.equal(by.findings.data_type, 'jsonb');
  assert.equal(by.notified_blockers.data_type, 'jsonb');
  assert.match(by.findings.column_default, /'\[\]'/);
  assert.match(by.blockers.column_default, /0/);
  assert.match(by.config_hash.column_default, /''/);
});

test('a row with only the key takes the defaults; the key is the primary key', { skip }, async () => {
  await db.pool.query(`INSERT INTO channel_readiness (channel_key) VALUES ('@mig_a')`);
  const { rows } = await db.pool.query(`SELECT * FROM channel_readiness WHERE channel_key = '@mig_a'`);
  assert.deepEqual(rows[0].findings, []);
  assert.equal(rows[0].blockers, 0);
  assert.equal(rows[0].warnings, 0);
  assert.equal(rows[0].config_hash, '');
  assert.equal(rows[0].applied_hash, null);
  assert.equal(rows[0].notified_at, null);
  assert.deepEqual(rows[0].notified_blockers, []);
  assert.ok(rows[0].checked_at instanceof Date);
  await assert.rejects(db.pool.query(`INSERT INTO channel_readiness (channel_key) VALUES ('@mig_a')`), /duplicate key/);
});

test('applying 097 again changes nothing: the row and the ledger stay', { skip }, async () => {
  const before = (await db.pool.query(`SELECT * FROM channel_readiness`)).rows;
  await applySql(db.pool, readMigration(UP));
  await applySql(db.pool, readMigration(UP));
  assert.deepEqual((await db.pool.query(`SELECT * FROM channel_readiness`)).rows, before);
  assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '097_channel_readiness'`)).rows[0].n, 1);
});

test('the down file runs twice, takes the table and the ledger row away; up again restores both', { skip }, async () => {
  await applySql(db.pool, readDown(DOWN));
  assert.equal(await tableExists(), false);
  assert.equal(await recorded(), false);
  await applySql(db.pool, readDown(DOWN));
  assert.equal(await tableExists(), false);
  await applySql(db.pool, readMigration(UP));
  assert.equal(await tableExists(), true);
  assert.equal(await recorded(), true);
  assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM channel_readiness`)).rows[0].n, 0, 'the rows went with the table');
  const idx = await db.pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'channel_readiness' ORDER BY 1`);
  assert.deepEqual(idx.rows.map((r) => r.indexname), ['channel_readiness_pkey', 'idx_channel_readiness_open']);
});
