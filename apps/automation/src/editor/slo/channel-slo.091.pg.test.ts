/**
 * Spec 091 against a throwaway Postgres: migration 104 up and down (channel_slo, editor_slots.slo, non-owner channel
 * pauses closed), and the day-row repository. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';
import { createProbeDb, MIGRATIONS_DIR, type ProbeDb } from '../agents/testing/probe-db';
import { ChannelSloRepository } from './channel-slo.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p091_slo');
  pool = db.pool;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('migration 104: closes non-owner channel pauses only; up, down twice, up again', { skip }, async () => {
  const up = readFileSync(join(MIGRATIONS_DIR, '104_channel_slo.sql'), 'utf8');
  const down = readFileSync(join(MIGRATIONS_DIR, 'down', '104_channel_slo.down.sql'), 'utf8');
  await pool.query(`INSERT INTO series_pauses (channel_key, series_key, label, cause) VALUES
    ('@a', 'resource:telegram:@a', 'telegram:@a', 'no_material'),
    ('@b', 'resource:telegram:@b', 'telegram:@b', 'owner'),
    ('@c', 'series:X', 'X', 'no_material')`);
  await pool.query(up);
  const open = (await pool.query(`SELECT channel_key, resumed_by FROM series_pauses ORDER BY channel_key`)).rows;
  assert.deepEqual(open, [{ channel_key: '@a', resumed_by: 'slo' }, { channel_key: '@b', resumed_by: null }, { channel_key: '@c', resumed_by: null }]);
  const exists = async () => ({
    table: (await pool.query(`SELECT to_regclass('public.channel_slo') AS t`)).rows[0].t !== null,
    col: (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'editor_slots' AND column_name = 'slo'`)).rowCount,
    version: (await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '104_channel_slo'`)).rowCount,
  });
  assert.deepEqual(await exists(), { table: true, col: 1, version: 1 });
  await pool.query(down);
  await pool.query(down);
  assert.deepEqual(await exists(), { table: false, col: 0, version: 0 });
  await pool.query(up);
  await pool.query(up);
  assert.deepEqual(await exists(), { table: true, col: 1, version: 1 });
});

test('repository: upsert keeps the counters, bump, get, forDay, history, lastBefore', { skip }, async () => {
  const repo = new ChannelSloRepository(pool);
  const row = { channelKey: '@x', day: '2026-11-06', target: 3, published: 1, plannedAhead: 1, skipped: 2, state: 'behind' as const,
    reason: '1 post(s) short', lastPostAt: new Date('2026-11-06T09:00:00Z'), darkSince: null };
  assert.equal(await repo.upsert(row), true);
  assert.equal(await repo.bump('@x', '2026-11-06', 'replacements'), 1);
  assert.equal(await repo.bump('@x', '2026-11-06', 'recovery_runs', 2), 2);
  assert.equal(await repo.upsert({ ...row, published: 3, state: 'met', reason: null }), true);
  const got = await repo.get('@x', '2026-11-06');
  assert.equal(got?.state, 'met');
  assert.equal(got?.replacements, 1, 'an upsert without counters keeps them');
  assert.equal(got?.recoveryRuns, 2);
  assert.equal(got?.day, '2026-11-06');
  await repo.upsert({ ...row, day: '2026-11-07', published: 0, state: 'dark', darkSince: new Date('2026-11-07T09:00:00Z') });
  assert.deepEqual((await repo.forDay('2026-11-07')).map((r) => r.state), ['dark']);
  assert.deepEqual((await repo.history('2026-11-07', 7, '@x')).map((r) => r.day), ['2026-11-07', '2026-11-06']);
  assert.equal((await repo.lastBefore('@x', '2026-11-07'))?.day, '2026-11-06');
  assert.equal(await repo.bump('@nope', '2026-11-07', 'replacements'), null);
});

test('upsert never throws', { skip }, async () => {
  const lines: string[] = [];
  const broken = new ChannelSloRepository({ query: async () => { throw new Error('relation "channel_slo" does not exist'); } } as any, (m) => lines.push(m));
  assert.equal(await broken.upsert({ channelKey: '@x', day: '2026-11-07', target: 1, published: 0, plannedAhead: 0, skipped: 0, state: 'behind', reason: null, lastPostAt: null, darkSince: null }), false);
  assert.match(lines[0], /not written/);
});
