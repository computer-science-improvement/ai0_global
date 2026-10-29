/**
 * Spec 076 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end): migration 100 up and
 * down, the `unreachable` strike through `PgHostFailures.record`, `succeeded` and what it keeps. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';
import { createProbeDb, MIGRATIONS_DIR, type ProbeDb } from '../agents/testing/probe-db';
import { PgHostFailures, feedKey } from './host-failures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);
const row = async (host: string) => (await pool.query(`SELECT * FROM source_host_failures WHERE host = $1`, [host])).rows[0];
const iso = (v: unknown) => new Date(v as string).toISOString();

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p076_reach');
  pool = db.pool;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('migration 100: up, the down twice, then up again (A17)', { skip }, async () => {
  const up = readFileSync(join(MIGRATIONS_DIR, '100_source_reach.sql'), 'utf8');
  const down = readFileSync(join(MIGRATIONS_DIR, 'down', '100_source_reach.down.sql'), 'utf8');
  const exists = async () => ({
    table: (await pool.query(`SELECT to_regclass('public.source_probes') AS t`)).rows[0].t !== null,
    cols: (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'source_host_failures'
          AND column_name IN ('consecutive_timeouts','timeouts_since','last_success_at') ORDER BY 1`)).rows.map((r) => r.column_name),
    version: (await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '100_source_reach'`)).rowCount,
  });
  assert.deepEqual(await exists(), { table: true, cols: ['consecutive_timeouts', 'last_success_at', 'timeouts_since'], version: 1 });
  await pool.query(`INSERT INTO source_host_failures (host, reason, blocked_until, strikes) VALUES ('mig.example', 'unreachable', now() + interval '1 day', 1)`);
  await pool.query(down);
  await pool.query(down);
  assert.deepEqual(await exists(), { table: false, cols: [], version: 0 });
  assert.equal((await row('mig.example')).reason, 'timeout', 'the old code does not know `unreachable`');
  await pool.query(up);
  await pool.query(up);
  assert.deepEqual(await exists(), { table: true, cols: ['consecutive_timeouts', 'last_success_at', 'timeouts_since'], version: 1 });
  await pool.query(`DELETE FROM source_host_failures WHERE host = 'mig.example'`);
});

test('record: three timeouts at least an hour apart make an unreachable strike, then 3 d and 7 d; a timeout inside a block is not counted', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const host = 'geo.example';
  await hosts.record(host, 'timeout');
  let r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts, iso(r.blocked_until)], ['timeout', 0, 1, plus(now, 1).toISOString()]);
  now = plus(now, 0.25); // inside the hour: the same attempt
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.consecutive_timeouts, r.failures, iso(r.blocked_until)], [1, 2, plus(now, 1).toISOString()]);
  now = plus(now, 2);
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['timeout', 0, 2]);
  now = plus(now, 2);
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts, iso(r.blocked_until)], ['unreachable', 1, 3, plus(now, 24).toISOString()]);
  assert.equal(iso(r.timeouts_since), '2026-10-20T08:00:00.000Z', 'the streak started with the first timeout');
  const b = await hosts.blocked(host, 'page');
  assert.equal(b?.reason, 'unreachable');
  assert.equal((await hosts.blocked(host, 'feed'))?.reason, 'unreachable', 'pages and feeds alike');

  now = plus(now, 3); // a timeout inside the block: nothing changes but the note of the attempt
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['unreachable', 1, 3]);
  assert.equal(iso(r.blocked_until), plus(new Date('2026-10-20T12:15:00Z'), 24).toISOString(), 'the day-long block is not shortened');

  now = plus(now, 25); // the block ended
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts, iso(r.blocked_until)], ['unreachable', 2, 4, plus(now, 72).toISOString()]);
  now = plus(now, 73);
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.strikes, iso(r.blocked_until)], [3, plus(now, 168).toISOString()]);
});

test('record: the window slides on the last failure; a refusal keeps the count and the strikes of a timeout streak alone', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const host = 'quiet.example';
  await hosts.record(host, 'timeout');
  now = plus(now, 2);
  await hosts.record(host, 'timeout');
  now = plus(now, 24 * 15); // over 14 days since the last failure
  await hosts.record(host, 'timeout');
  let r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['timeout', 0, 1], 'the count started over');
  assert.equal(iso(r.timeouts_since), now.toISOString());

  const mixed = 'mixed.example';
  await hosts.record(mixed, 'timeout');
  now = plus(now, 2);
  await hosts.record(mixed, 'timeout');
  now = plus(now, 2);
  await hosts.record(mixed, 'refused', 403);
  r = await row(mixed);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['refused', 1, 2], 'the refusal is a strike and leaves the count');
  now = plus(now, 25);
  await hosts.record(mixed, 'timeout');
  r = await row(mixed);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['unreachable', 2, 3]);
});

test('succeeded (A2): a page success resets everything; a feed success keeps a refusal streak; both end a timeout / unreachable block', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);

  // A refused streak with strikes 2 and a note: a feed success keeps both, a page success resets them.
  const refused = 'refused.example';
  await hosts.record(refused, 'refused', 403);
  now = plus(now, 25);
  await hosts.record(refused, 'refused', 403);
  await pool.query(`UPDATE source_host_failures SET noted_at = $2 WHERE host = $1`, [refused, now]);
  now = plus(now, 1);
  await hosts.succeeded(refused, 'feed');
  let r = await row(refused);
  assert.equal(r.strikes, 2, 'a working feed never wipes the page refusals of its host');
  assert.ok(r.noted_at);
  assert.equal(iso(r.last_success_at), now.toISOString());
  assert.equal(iso(r.blocked_until), plus(new Date('2026-10-21T09:00:00Z'), 72).toISOString(), 'a refusal block is not ended');
  await hosts.succeeded(refused);
  r = await row(refused);
  assert.deepEqual([r.strikes, r.noted_at], [0, null]);

  // A feed success ends an unreachable block and writes last_success_at.
  const geo = 'ended.example';
  for (let i = 0; i < 3; i++) {
    await hosts.record(geo, 'timeout');
    now = plus(now, 2);
  }
  r = await row(geo);
  assert.equal(r.reason, 'unreachable');
  assert.ok((await hosts.blocked(geo, 'page')));
  await pool.query(`UPDATE source_host_failures SET noted_at = $2 WHERE host = $1`, [geo, now]);
  await hosts.succeeded(geo, 'feed');
  r = await row(geo);
  assert.deepEqual([r.strikes, r.noted_at, r.consecutive_timeouts, r.timeouts_since], [0, null, 0, null]);
  assert.equal(iso(r.last_success_at), now.toISOString());
  assert.equal(iso(r.blocked_until), now.toISOString(), 'the block ends now');
  assert.equal(await hosts.blocked(geo, 'page'), null);

  // A new streak starts at one.
  now = plus(now, 1);
  await hosts.record(geo, 'timeout');
  r = await row(geo);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['timeout', 0, 1]);

  // A page success on a timeout block does the same, and a host with no row is a no-op.
  await hosts.succeeded(geo);
  assert.equal(await hosts.blocked(geo, 'page'), null);
  await hosts.succeeded('norow.example');
  assert.equal(await row('norow.example'), undefined);
});

test('succeeded: the feed key recovers after a good read (A8)', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const key = feedKey('https://feeds.example/rss/all.xml')!;
  for (let i = 0; i < 3; i++) {
    await hosts.record(key, 'timeout');
    now = plus(now, 2);
  }
  assert.equal((await row(key)).reason, 'unreachable');
  assert.equal((await hosts.blocked(key, 'feed'))?.reason, 'unreachable');
  await hosts.succeeded(key, 'feed');
  assert.equal(await hosts.blocked(key, 'feed'), null);
  assert.equal(iso((await row(key)).last_success_at), now.toISOString());
});
