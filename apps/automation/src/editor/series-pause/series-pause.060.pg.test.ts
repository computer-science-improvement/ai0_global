/**
 * Spec 060 T1 against a throwaway Postgres: migration 093 (applies twice, the check on the cause), one open pause per
 * series through the partial unique index, the breaker end to end (closed slots → one pause, one Inbox note, planned
 * slots of the series skipped with `series_paused`, other series and channels untouched), a resume starts a new count,
 * and what the planners read (paused series, a slot of one is a plan error). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { OwnerInbox } from '../agents/owner-inbox';
import { planScheduleErrors, type PlanScheduleCtx } from '../schedule/plan-schedule-rules';
import { PlannerPauseView } from './planner-view';
import { SeriesBreaker } from './series-breaker';
import { SeriesPausesRepository } from './series-pauses.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '093_series_pauses.sql'), 'utf8');
const CH = '@pgt060_prompts';
const OTHER = '@pgt060_other';
const NO_TEXT = 'skipped by agent: у рядках немає повного тексту промпту';
const HOUR = 3600_000;
let pool: Pool;
let repo: SeriesPausesRepository;
let inbox: OwnerInbox;
let threshold = 3;

const cleanup = async () => {
  await pool.query(`DELETE FROM agent_inbox WHERE kind = 'series_paused' AND title LIKE '%pgt060%'`);
  await pool.query(`DELETE FROM series_pauses WHERE channel_key LIKE '@pgt060%'`);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key LIKE '@pgt060%'`);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key LIKE '@pgt060%'`);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key LIKE '@pgt060%'`);
};

const planIds = new Map<string, string>();
const channels = new Set<string>();
async function planOf(channel: string, at: Date): Promise<string> {
  const day = at.toISOString().slice(0, 10);
  const key = `${channel}|${day}`;
  if (planIds.has(key)) return planIds.get(key)!;
  if (!channels.has(channel)) {
    await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, $2, 'pgt060', true)`, [channel, channel.slice(1)]);
    await pool.query(`INSERT INTO editor_channels (channel_key, mode, plan_hour, formats) VALUES ($1, 'live', 0, '{"text":1}') ON CONFLICT (channel_key) DO NOTHING`, [channel]);
    channels.add(channel);
  }
  const id = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, $2, 'pgt060', 'superseded') RETURNING id`, [channel, day])).rows[0].id;
  planIds.set(key, id);
  return id;
}

async function slot(o: { channel?: string; series?: string | null; status: string; error?: string | null; at: Date; kind?: string }): Promise<string> {
  const channel = o.channel ?? CH;
  return (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, status, error, series_name) VALUES ($1, $2, $3, $4, 'text', 'pgt060', $5, $6, $7) RETURNING id`,
    [await planOf(channel, o.at), channel, o.at, o.kind ?? 'content', o.status, o.error ?? null, o.series === undefined ? 'Prompt' : o.series])).rows[0].id;
}
const state = async (id: string) => (await pool.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [id])).rows[0] as { status: string; error: string | null };

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(MIGRATION);
  await cleanup();
  repo = new SeriesPausesRepository(pool);
  inbox = new OwnerInbox(pool as any, async () => {});
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

/** The breaker over this suite's channels only (a shared test database may hold other suites' slots). */
const breaker = () => new SeriesBreaker({
  repo: Object.assign(Object.create(repo), {
    closedSlots: async (now: Date) => (await repo.closedSlots(now)).filter((s) => s.channelKey.startsWith('@pgt060')),
    open: async () => (await repo.open()).filter((p) => p.channelKey.startsWith('@pgt060')),
  }),
  inbox, threshold: () => threshold, everyMs: 0,
});

test('093 applies again; the cause is checked; one open pause per series, a resumed one does not block the next', { skip }, async () => {
  await pool.query(MIGRATION);
  await assert.rejects(pool.query(`INSERT INTO series_pauses (channel_key, series_key, label, cause) VALUES ($1, 'series:X', 'X', 'weird')`, [`${CH}_x`]));
  const a = await repo.insertOpen({ channelKey: `${CH}_x`, key: 'series:X', label: 'X', cause: 'no_material', reason: 'r', streak: 3 });
  assert.ok(a);
  assert.equal(await repo.insertOpen({ channelKey: `${CH}_x`, key: 'series:X', label: 'X', cause: 'source_unreachable', reason: 'again', streak: 4 }), null, 'one open pause per series');
  assert.ok(await repo.insertOpen({ channelKey: `${CH}_x`, key: 'series:Y', label: 'Y', cause: 'owner', reason: '', streak: 0 }), 'another series is fine');
  assert.equal((await repo.open(`${CH}_X`.toUpperCase())).length, 2, 'the channel key matches case-insensitively');
  const r = await repo.resume(a!.id, 'owner');
  assert.equal(r?.resumedBy, 'owner');
  assert.ok(r?.resumedAt);
  assert.equal(await repo.resume(a!.id, 'owner'), null, 'resuming twice does nothing');
  assert.ok(await repo.insertOpen({ channelKey: `${CH}_x`, key: 'series:X', label: 'X', cause: 'no_material', reason: 'later', streak: 3 }), 'a resumed series can be paused again');
  assert.equal((await repo.list(`${CH}_x`)).length, 3);
  assert.ok((await repo.lastResumes()).has(`${CH}_x|series:X`));
  await pool.query(`DELETE FROM series_pauses WHERE channel_key = $1`, [`${CH}_x`]);
});

test('breaker: 3 skips in a row pause the series once, skip its planned slots at $0 and leave everything else alone', { skip }, async () => {
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * HOUR);
  const dead = [await slot({ status: 'skipped', error: NO_TEXT, at: ago(70) }), await slot({ status: 'skipped', error: 'source_already_posted: https://x', at: ago(50) }), await slot({ status: 'skipped', error: NO_TEXT, at: ago(30) })];
  await slot({ status: 'skipped', error: 'rejected by owner', at: ago(20) });                          // transparent
  const planned = [await slot({ status: 'planned', at: new Date(now.getTime() + 2 * HOUR) }), await slot({ status: 'planned', at: new Date(now.getTime() + 26 * HOUR) })];
  const otherSeries = await slot({ status: 'planned', series: 'Works', at: new Date(now.getTime() + 3 * HOUR) });
  const plain = await slot({ status: 'planned', series: null, at: new Date(now.getTime() + 4 * HOUR) });
  const otherChannel = await slot({ channel: OTHER, status: 'planned', at: new Date(now.getTime() + 2 * HOUR) });
  const reserved = await slot({ status: 'planned', kind: 'reserved', at: new Date(now.getTime() + 5 * HOUR) });

  assert.equal(await breaker().check(now), 1);
  const open = await repo.open(CH);
  assert.equal(open.length, 1);
  assert.equal(open[0].key, 'series:Prompt');
  assert.equal(open[0].cause, 'no_material');
  assert.equal(open[0].streak, 3);
  assert.match(open[0].reason, /немає повного тексту/);
  assert.deepEqual((await pool.query(`SELECT kind, severity, ref_type, ref_id FROM agent_inbox WHERE kind = 'series_paused' AND ref_id = $1`, [open[0].id])).rows,
    [{ kind: 'series_paused', severity: 'action', ref_type: 'series_pause', ref_id: open[0].id }]);

  for (const id of planned) assert.deepEqual(await state(id), { status: 'skipped', error: `series_paused: "Prompt" is paused after repeated skips (spec 060)` });
  assert.equal((await state(otherSeries)).status, 'planned', 'another series');
  assert.equal((await state(plain)).status, 'planned', 'a slot without a series');
  assert.equal((await state(otherChannel)).status, 'planned', 'another channel');
  assert.equal((await state(reserved)).status, 'planned', 'a reserved (ad) slot is never touched');
  for (const id of dead) assert.equal((await state(id)).status, 'skipped');

  // The next ticks add nothing, but a slot planned later for the paused series is skipped too.
  const late = await slot({ status: 'planned', at: new Date(now.getTime() + 8 * HOUR) });
  assert.equal(await breaker().check(now), 0);
  assert.equal((await state(late)).status, 'skipped');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_inbox WHERE kind = 'series_paused' AND title LIKE '%@pgt060_prompts%'`)).rows[0].n, 1, 'one note');

  // What the planners read.
  const view = await new PlannerPauseView(repo).forChannel(CH, now);
  assert.deepEqual(view.paused.map((p) => p.name), ['Prompt']);
  const ctx = { planDate: now.toISOString().slice(0, 10), defaultRef: `telegram:${CH}`, now, clocks: { [`telegram:${CH}`]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 7 }, gapMin: 30 } }, rules: [], pins: [], series: [], paused: view.paused } as PlanScheduleCtx;
  assert.ok(planScheduleErrors({ slots: [{ time: '12:00', series: 'Prompt', source_hints: [] }] }, ctx, `telegram:${CH}`).some((e) => /серія «Prompt» на паузі/.test(e)));
  assert.deepEqual(planScheduleErrors({ slots: [{ time: '12:00', series: 'Works', source_hints: [] }] }, ctx, `telegram:${CH}`), []);

  // The owner resumes: the old skips do not pause it again, a new streak does.
  await repo.resume(open[0].id, 'owner');
  assert.equal(await breaker().check(new Date(now.getTime() + 1000)), 0, 'the skips before the resume do not count');
  assert.equal((await new PlannerPauseView(repo).forChannel(CH, now)).paused.length, 0);
  const t = new Date(now.getTime() + 2 * HOUR);
  for (let i = 0; i < 3; i++) await slot({ status: 'skipped', error: NO_TEXT, at: new Date(t.getTime() + i * HOUR) });
  assert.equal(await breaker().check(new Date(t.getTime() + 5 * HOUR)), 1, 'three new skips pause it again');
  assert.equal((await repo.list(CH)).length, 2, 'the history keeps both pauses');
});

test('breaker: threshold 0 is off; a plain-slot pause stops planning of the channel', { skip }, async () => {
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * HOUR);
  const ch = '@pgt060_plain';
  for (const h of [90, 60, 30]) await slot({ channel: ch, series: null, status: 'skipped', error: 'no_fresh_item: нічого свіжого', at: ago(h) });
  threshold = 0;
  assert.equal(await breaker().check(now), 0);
  assert.equal((await repo.open(ch)).length, 0);
  threshold = 3;
  assert.equal(await breaker().check(now), 1);
  assert.deepEqual([...(await repo.plainPausedChannels())].filter((c) => c.startsWith('@pgt060')), [ch]);
  const p = (await repo.open(ch))[0];
  assert.equal(p.key, `resource:telegram:${ch}`);
  const planned = await slot({ channel: ch, series: null, status: 'planned', at: new Date(now.getTime() + HOUR) });
  await breaker().check(now);
  assert.equal((await state(planned)).status, 'skipped');
});
