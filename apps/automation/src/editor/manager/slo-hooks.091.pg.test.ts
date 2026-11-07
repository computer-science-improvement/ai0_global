/**
 * Spec 091 T9/T10 against a throwaway Postgres (own database, created and dropped here): the escalation query reads the SLO
 * day row, the KPI digest signal, the directive slot mark, silent days reading a real row, and the daily report's «Канали».
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AgentsRepository } from '../agents/agents.repository';
import { makeCard } from '../post/testing/fixtures';
import { SilentDaysWatch } from '../silent/silent-days';
import { channelText, withSlo } from '../owner-bot/owner-reports';
import { ChannelSloRepository } from '../slo/channel-slo.repository';
import { negativePostsDays } from './escalation';
import { sloSignalsOf } from './kpi-digest.service';
import { markDirectiveSlot } from './executors/task-report';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let slo: ChannelSloRepository;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p091c_hooks');
  slo = new ChannelSloRepository(db.pool);
});
after(async () => {
  if (!url) return;
  await db.drop();
});

const base = { target: 2, published: 0, plannedAhead: 0, skipped: 0, reason: null, lastPostAt: null, darkSince: null };

test('escalation: a starved or dark channel is counted although a breaker pause row is open; a held one is left out; no row keeps today\'s rule', { skip }, async () => {
  const agents = new AgentsRepository(db.pool);
  const handles = ['starved', 'dark', 'held', 'norow', 'behind'];
  for (const h of handles) {
    await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:@e091_${h}`, name: h, handle: `e091_${h}`, mode: 'live', createdBy: 'owner' });
    await db.pool.query(
      `INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak) VALUES ($1, $2, $3, 'no_material', 'r', 3)`,
      [`@e091_${h}`, `resource:telegram:@e091_${h}`, `telegram:@e091_${h}`]);
    await db.pool.query(
      `INSERT INTO kpi_snapshots (scope, scope_id, day, metrics) VALUES ('resource', $1, '2026-11-05', $2::jsonb)`,
      [`telegram:@e091_${h}`, JSON.stringify({ posts: { v: 0, base: 3, d: -100, z: -3, anomaly: true } })]);
  }
  await slo.upsert({ ...base, channelKey: '@e091_starved', day: '2026-11-05', state: 'starved' });
  await slo.upsert({ ...base, channelKey: '@e091_dark', day: '2026-11-04', state: 'dark' });          // the day before the snapshot counts too
  await slo.upsert({ ...base, channelKey: '@e091_held', day: '2026-11-05', target: 0, state: 'held' });
  await slo.upsert({ ...base, channelKey: '@e091_behind', day: '2026-11-05', state: 'behind' });
  const got = (await negativePostsDays(db.pool, '2026-11-01')).map((r) => r.handle).sort();
  assert.deepEqual(got, ['e091_dark', 'e091_starved'], 'the pause row still excludes a norow/behind channel; starved and dark come back; held stays out');
});

test('escalation: a held day row leaves out a channel that has no pause at all', { skip }, async () => {
  await new AgentsRepository(db.pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@e091_heldfree', name: 'h', handle: 'e091_heldfree', mode: 'live', createdBy: 'owner' });
  await db.pool.query(
    `INSERT INTO kpi_snapshots (scope, scope_id, day, metrics) VALUES ('resource', 'telegram:@e091_heldfree', '2026-11-05', $1::jsonb)`,
    [JSON.stringify({ posts: { v: 0, base: 3, d: -100, z: -3, anomaly: true } })]);
  assert.ok((await negativePostsDays(db.pool, '2026-11-01')).some((r) => r.handle === 'e091_heldfree'));
  await slo.upsert({ ...base, channelKey: '@e091_heldfree', day: '2026-11-05', target: 0, state: 'held' });
  assert.ok(!(await negativePostsDays(db.pool, '2026-11-01')).some((r) => r.handle === 'e091_heldfree'));
});

test('digest signal: today\'s rows by resource ref', { skip }, async () => {
  await slo.upsert({ ...base, channelKey: '@d091', day: '2026-11-06', state: 'recovering', published: 1, reason: 'one replacement running', replacements: 1 });
  const m = await sloSignalsOf(db.pool, '2026-11-06');
  assert.deepEqual(m.get('telegram:@d091'), { state: 'recovering', target: 2, published: 1, replacements: 1, reason: 'one replacement running' });
  assert.equal((await sloSignalsOf(db.pool, '2026-11-07')).size, 0);
});

async function slot(channel: string): Promise<string> {
  await db.pool.query(`INSERT INTO editor_channels (channel_key, timezone) VALUES ($1, 'Europe/Kyiv') ON CONFLICT (channel_key) DO NOTHING`, [channel]);
  const { rows: p } = await db.pool.query(
    `INSERT INTO editor_plans (channel_key, plan_date, status, rationale) VALUES ($1, (now() AT TIME ZONE 'Europe/Kyiv')::date, 'active', 't') RETURNING id`, [channel]);
  const { rows } = await db.pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status) VALUES ($1, $2, now(), 'text', 'Тема', 'planned') RETURNING id`, [p[0].id, channel]);
  return rows[0].id;
}
const kyivToday = async () => (await db.pool.query(`SELECT (now() AT TIME ZONE 'Europe/Kyiv')::date::text AS d`)).rows[0].d as string;

test('task directive slot: marked only on a recovering or dark channel, once', { skip }, async () => {
  const today = await kyivToday();
  const rec = await slot('@t091rec');
  const met = await slot('@t091met');
  const none = await slot('@t091none');
  await slo.upsert({ ...base, channelKey: '@t091rec', day: today, state: 'recovering' });
  await slo.upsert({ ...base, channelKey: '@t091met', day: today, state: 'met', published: 2 });
  assert.equal(await markDirectiveSlot(db.pool, rec), true);
  assert.equal(await markDirectiveSlot(db.pool, met), false);
  assert.equal(await markDirectiveSlot(db.pool, none), false);
  assert.equal(await markDirectiveSlot(db.pool, rec), false, 'already marked');
  const { rows } = await db.pool.query(`SELECT id, slo FROM editor_slots WHERE id = ANY($1::uuid[]) ORDER BY channel_key`, [[rec, met, none]]);
  const by = new Map(rows.map((r: any) => [r.id, r.slo]));
  assert.deepEqual(by.get(rec), { replaces: null, rung: 'directive', cause: null, depth: 1 });
  assert.equal(by.get(met), null);
  assert.equal(by.get(none), null);
});

test('silent days load: the real day row gives the target and the state', { skip }, async () => {
  const today = await kyivToday();
  await slo.upsert({ ...base, channelKey: '@s091', day: today, state: 'starved', target: 2 });
  const watch = new SilentDaysWatch({ pool: db.pool, inbox: { postOnce: async () => null } });
  const { resources } = await watch.load([makeCard({ channelKey: '@s091', mode: 'live', postsPerDayMin: 1, timezone: 'Europe/Kyiv' })], new Date());
  const r = resources.find((x) => x.ref === 'telegram:@s091')!;
  assert.deepEqual([r.minPerDay, r.slo], [2, { target: 2, state: 'starved' }]);
});

test('daily report: withSlo on the real table adds target and state, and a dark channel with no slots', { skip }, async () => {
  const day = '2026-11-03';
  await slo.upsert({ ...base, channelKey: '@r091a', day, state: 'behind', target: 3, published: 1 });
  await slo.upsert({ ...base, channelKey: '@r091dark', day, state: 'dark', target: 1 });
  await db.pool.query(`INSERT INTO editor_channels (channel_key, title) VALUES ('@r091dark', 'Темний канал') ON CONFLICT (channel_key) DO UPDATE SET title = EXCLUDED.title`);
  const lines = await withSlo(db.pool, [{ ref: 'telegram:@r091a', title: 'A', published: 1, skipped: 1, skipWhy: 'критик', failed: 0, awaiting: 0, subs: null }], day);
  assert.deepEqual(lines.map((l) => channelText(l)), [
    '• <b>A</b>: ✅ 1/3 · не встигає · ⏭ 1 (критик)',
    '• <b>Темний канал</b>: ✅ 0/1 · без постів',
  ].sort());
});
