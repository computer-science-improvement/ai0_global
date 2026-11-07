/**
 * Spec 091 T2/T4/T5/T8 against a throwaway Postgres (EDITOR_PG_TEST_URL): the scheduler, the breaker, the controller and the
 * inserter end to end with the real repositories. A skipped plain slot gets one replacement and the channel keeps planning;
 * the replacement is idempotent, honours spacing / quiet hours / the day's end / depth 2 / the day's maximum, survives a replan;
 * a dark channel gets one recovery run (and an evergreen slot when the planner plans nothing) and one 72-hour note.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { OwnerInbox } from '../agents/owner-inbox';
import { ApprovalsRepository } from '../approval/approvals.repository';
import { AutonomyDecisionsRepository } from '../autonomy/autonomy-decisions.repository';
import { EditorScheduler } from '../editor.scheduler';
import type { EditorCard } from '../card';
import { makeCard } from '../post/testing/fixtures';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { SeriesBreaker } from '../series-pause/series-breaker';
import { SeriesPausesRepository } from '../series-pause/series-pauses.repository';
import { ChannelSloRepository } from './channel-slo.repository';
import { SloController } from './slo-controller';
import { StubDarkRecovery, StubRungPlanner } from './slo-stubs';
import { SloSlotInserter } from './slot-inserter';
import { earliestFreeTime } from './slot-time';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;
let plans: EditorPlansRepository;

// Friday 2026-11-06, 11:00 in Kyiv (UTC+2).
const NOW = new Date('2026-11-06T09:00:00Z');
const DAY = '2026-11-06';
const HOUR = 3_600_000;
const CH = '@p091flow';
let seq = 0;
const env: Record<string, string> = {};
const envFn = (k: string) => env[k];

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p091a_flow');
  pool = db.pool;
  plans = new EditorPlansRepository(pool, () => NOW);
});
after(async () => { if (url) await db.drop(); });

async function channel(extra: Partial<EditorCard> = {}): Promise<EditorCard & { createdAt: Date }> {
  const key = `${CH}${++seq}`;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, $2, 'p091', true)`, [key, key.slice(1)]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, plan_hour, formats, posts_per_day_min, posts_per_day_max) VALUES ($1, 'live', 0, '{"text":1}', 3, 5)`, [key]);
  return { ...makeCard({ channelKey: key, mode: 'live', postsPerDayMin: 3, postsPerDayMax: 5, planHour: 0, ...extra }), createdAt: new Date(NOW.getTime() - 2 * HOUR) };
}

const at = (hhmmZ: string, day = DAY) => new Date(`${day}T${hhmmZ}:00Z`);
async function makePlan(card: EditorCard, times: string[]): Promise<string[]> {
  await plans.createPlan(card.channelKey, DAY, 'plan for the day, spec 091 test', null,
    times.map((t, i) => ({ scheduledAt: at(t), format: 'text', topic: `topic ${i}`, angle: null, sourceHints: [], isExperiment: false })));
  const { rows } = await pool.query(`SELECT id FROM editor_slots WHERE channel_key = $1 ORDER BY scheduled_at`, [card.channelKey]);
  return rows.map((r) => r.id);
}

function build(card: EditorCard & { createdAt: Date }, o: { sloOn?: boolean; mode?: 'live' | 'shadow' } = {}) {
  const log: string[] = [];
  const planner: Array<{ ch: string; extra?: string | null }> = [];
  const repo = new ChannelSloRepository(pool, (m) => log.push(m));
  const inserter = new SloSlotInserter({ pool, env: envFn });
  const inbox = new OwnerInbox(pool);
  const pauses = new SeriesPausesRepository(pool, { sloOn: () => o.sloOn !== false, log: (m) => log.push(m) });
  let scheduler: EditorScheduler;
  const controller = new SloController({
    pool, repo, inserter, planner: new StubRungPlanner(),
    dark: new StubDarkRecovery({ pool, inserter, resetTries: (k, n) => scheduler.resetPlannerTries(k, n), runPlanner: (c, extra) => scheduler.runPlannerNow(c, extra) }),
    env: envFn, card: async () => card, slot: (id) => plans.getSlot(id),
    inbox, decisions: new AutonomyDecisionsRepository(pool as any), log: (m) => log.push(m),
    context: async () => ({ mode: o.mode ?? 'live', heldReason: null, playbookPerDay: null, ownerPausedSlots: 0 }),
  });
  const breaker = new SeriesBreaker({
    repo: pauses, inbox, threshold: () => 3, everyMs: 0,
    sloOn: () => o.sloOn !== false, onPlainStreak: (k, hit) => controller.onPlainStreak(k, hit),
  });
  scheduler = new EditorScheduler({
    pool, channels: { listActive: async () => [card] }, plans,
    runner: {
      runPlanner: async (c: any, opts?: any) => { planner.push({ ch: c.channelKey, extra: opts?.extra }); return {} as any; },
      // The executor skips every slot it is given, the way skipByCode / skip_slot would.
      runExecutor: async (slot: any) => { await plans.updateSlot(slot.id, { status: 'skipped', error: 'no_fresh_item: nothing fresh in the feeds' }); return {} as any; },
      runReviewer: async () => ({}) as any,
    },
    enabled: () => true, notify: async () => {}, log: (m) => log.push(m),
    seriesPauses: { check: (n) => breaker.check(n, true), plainPaused: () => pauses.plainPausedChannels() },
    slo: controller,
  });
  return { scheduler, controller, repo, inserter, planner, log, pauses };
}

const sloRows = async (key: string) => (await pool.query(`SELECT id, status, scheduled_at, replaces_slot_id, slo, plan_id, series_name FROM editor_slots WHERE channel_key = $1 AND slo IS NOT NULL ORDER BY scheduled_at`, [key])).rows;
async function settle() { await new Promise((r) => setTimeout(r, 150)); }

test('T2/T5: a skipped plain slot gets one replacement (idempotent), and the channel keeps planning with its plain pause streak', { skip }, async () => {
  const card = await channel();
  // Two older plain skips (more than 20 h apart) so that today's skip completes a streak of three.
  const [s1, s2, s3] = await makePlan(card, ['08:00', '13:00', '15:00']);
  for (const [d, t] of [['2026-11-04', '08:00'], ['2026-11-05', '08:00']]) {
    await plans.createPlan(card.channelKey, d, 'older plan for the streak test', null, [{ scheduledAt: at(t, d), format: 'text', topic: 'old', angle: null, sourceHints: [], isExperiment: false }]);
    await pool.query(`UPDATE editor_slots SET status = 'skipped', error = 'no_fresh_item: nothing', updated_at = $2 WHERE channel_key = $1 AND scheduled_at = $3`, [card.channelKey, at(t, d), at(t, d)]);
  }
  const f = build(card);
  await f.scheduler.tick(NOW);
 // claims s1 (due), the executor skips it, the controller hears of it
  await settle();
  const marked = await sloRows(card.channelKey);
  assert.equal(marked.length, 1, 'one replacement');
  assert.equal(marked[0].replaces_slot_id, s1);
  assert.deepEqual(marked[0].slo, { replaces: s1, rung: 'evergreen', cause: 'no_material', depth: 1 });
  assert.equal(marked[0].status, 'planned');
  assert.equal(new Date(marked[0].scheduled_at).toISOString(), '2026-11-06T09:15:00.000Z', 'now + SLO_REPLACEMENT_LEAD_MIN (15)');
  const active = (await pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`, [card.channelKey, DAY])).rows[0].id;
  assert.equal(marked[0].plan_id, active, 'in the channel\'s active plan');
  const row = await f.repo.get(card.channelKey, DAY);
  assert.equal(row?.replacements, 1);
  assert.equal(row?.target, 3);
  assert.equal(row?.skipped, 1);

  // A second close event of the same slot adds nothing; neither does the approval path.
  assert.equal(await f.controller.handleClosed(s1, NOW), null);
  const again = await f.inserter.insert(card, { format: 'text', topic: 'again' }, { replaces: s1, rung: 'evergreen', cause: 'no_material', depth: 1 }, NOW);
  assert.equal(again, null, 'the unique replaces_slot_id');
  assert.equal(await new ApprovalsRepository(pool).insertReplacement((await plans.getSlot(s1))!, 'owner rejected'), null, 'an approval cannot add a second replacement');
  assert.equal((await sloRows(card.channelKey)).length, 1);
  assert.ok(s2 && s3);

  // The next tick: the breaker sees three plain skips in a row. With the controller on it pauses nothing and the channel is not gated.
  await f.scheduler.tick(new Date(NOW.getTime() + 60_000));
  const paused = (await pool.query(`SELECT 1 FROM series_pauses WHERE channel_key = $1`, [card.channelKey])).rowCount;
  assert.equal(paused, 0, 'no resource: pause');
  assert.equal(await f.pauses.insertOpen({ channelKey: card.channelKey, key: `resource:telegram:${card.channelKey}`, label: 'x', cause: 'no_material', reason: '', streak: 3 }), null, 'the repository refuses it');
  assert.equal((await f.pauses.plainPausedChannels()).size, 0);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1 AND plan_date = $2`, [card.channelKey, DAY]);   // no plan today: the planner must run
  await f.scheduler.tick(new Date(NOW.getTime() + 2 * 60_000));
  assert.ok(f.planner.some((p) => p.ch === card.channelKey), 'the channel keeps planning');
});

test('T4: SLO_CONTROLLER off keeps today\'s behaviour: the streak pauses the channel and the gate stops its planning', { skip }, async () => {
  env.SLO_CONTROLLER = 'off';
  try {
    const card = await channel();
    for (const [d, t] of [['2026-11-03', '08:00'], ['2026-11-04', '08:00'], ['2026-11-05', '08:00']]) {
      await plans.createPlan(card.channelKey, d, 'older plan for the streak test', null, [{ scheduledAt: at(t, d), format: 'text', topic: 'old', angle: null, sourceHints: [], isExperiment: false }]);
      await pool.query(`UPDATE editor_slots SET status = 'skipped', error = 'no_fresh_item: nothing', updated_at = $2 WHERE channel_key = $1 AND scheduled_at = $3`, [card.channelKey, at(t, d), at(t, d)]);
    }
    const f = build(card, { sloOn: false });
    await f.scheduler.tick(NOW);
    assert.equal((await pool.query(`SELECT 1 FROM series_pauses WHERE channel_key = $1 AND series_key LIKE 'resource:telegram:%'`, [card.channelKey])).rowCount, 1);
    f.planner.length = 0;
    await f.scheduler.tick(new Date(NOW.getTime() + 60_000));
    assert.equal(f.planner.length, 0, 'gated: not planned');
    assert.equal(await f.repo.get(card.channelKey, DAY), null, 'the controller did not run');
  } finally { delete env.SLO_CONTROLLER; }
});

test('T5: the inserter respects spacing, quiet hours, the day\'s end, depth 2 and the day\'s maximum', { skip }, async () => {
  const card = await channel();
  const inserter = new SloSlotInserter({ pool, env: envFn });
  const spec = { format: 'text', topic: 'r' };
  // Spacing: a planned slot at 09:10Z pushes the replacement to 10:10Z (min gap 60 min), the first minute that is free.
  await makePlan(card, ['09:10', '15:00']);
  const id = await inserter.insert(card, spec, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, NOW);
  assert.ok(id);
  assert.equal(new Date((await sloRows(card.channelKey))[0].scheduled_at).toISOString(), '2026-11-06T10:10:00.000Z');
  // Depth 2 is the last: a replacement of a replacement of a replacement is refused.
  assert.equal(await inserter.insert(card, spec, { replaces: null, rung: 'evergreen', cause: 'quality', depth: 3 }, NOW), null);
  // The lead time setting is live.
  env.SLO_REPLACEMENT_LEAD_MIN = '60';
  try {
    const t = await earliestFreeTime(pool, card, DAY, NOW, 60);
    assert.ok(t && t.getTime() >= NOW.getTime() + HOUR);
    const other = await channel();
    const id2 = await inserter.insert(other, spec, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, NOW);
    assert.ok(id2);
    assert.equal(new Date((await sloRows(other.channelKey))[0].scheduled_at).toISOString(), '2026-11-06T10:00:00.000Z');
  } finally { delete env.SLO_REPLACEMENT_LEAD_MIN; }
  // Quiet hours (23-08 Kyiv) and the end of the day: at 23:50 Kyiv nothing is left; at 22:50 Kyiv 23:05 is quiet, so nothing either.
  const late = await channel();
  assert.equal(await inserter.insert(late, spec, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, new Date('2026-11-06T21:50:00Z')), null);
  assert.equal(await inserter.insert(late, spec, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, new Date('2026-11-06T20:50:00Z')), null);
  assert.equal((await sloRows(late.channelKey)).length, 0);
  // 21:00 Kyiv: 21:15 is fine.
  assert.ok(await inserter.insert(late, spec, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, new Date('2026-11-06T19:00:00Z')));
  // The day's maximum (5) is a hard rule.
  const full = await channel({ postsPerDayMax: 2 });
  await makePlan(full, ['13:00', '15:00']);
  assert.equal(await inserter.insert(full, spec, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, NOW), null);
});

test('T5: a day without a plan gets a placeholder plan for the slot (the planner still plans that day)', { skip }, async () => {
  const card = await channel();
  const inserter = new SloSlotInserter({ pool, env: envFn });
  assert.ok(await inserter.insert(card, { format: 'text', topic: 'r' }, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, NOW));
  const plan = (await pool.query(`SELECT rationale FROM editor_plans WHERE channel_key = $1 AND status = 'active'`, [card.channelKey])).rows;
  assert.deepEqual(plan.map((p) => p.rationale), ['reserved only']);
});

test('T5: replacePlan keeps the controller\'s slots (slo) and moves them to the new plan; other future slots are replaced', { skip }, async () => {
  const card = await channel();
  const [a, b] = await makePlan(card, ['13:00', '15:00']);
  const inserter = new SloSlotInserter({ pool, env: envFn });
  const id = await inserter.insert(card, { format: 'text', topic: 'kept' }, { replaces: a, rung: 'evergreen', cause: 'no_material', depth: 1 }, NOW);
  assert.ok(id);
  await plans.createPlan(card.channelKey, DAY, 'a second plan of the day, replan', null,
    [{ scheduledAt: at('17:00'), format: 'text', topic: 'new', angle: null, sourceHints: [], isExperiment: false }]);
  const kept = (await pool.query(`SELECT status, plan_id FROM editor_slots WHERE id = $1`, [id])).rows[0];
  const active = (await pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND status = 'active'`, [card.channelKey])).rows[0].id;
  assert.equal(kept.status, 'planned');
  assert.equal(kept.plan_id, active);
  const replaced = (await pool.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [b])).rows[0];
  assert.equal(replaced.status, 'skipped');
  assert.equal(replaced.error, 'superseded by a new plan');
});

test('T5: skipStale reports the slots it closed (the controller hears of them)', { skip }, async () => {
  const card = await channel();
  const [s1] = await makePlan(card, ['04:00', '15:00']);
  const ids: string[] = [];
  const n = await plans.skipStale(NOW, 3 * HOUR, (x) => ids.push(...x));
  assert.equal(n, 1);
  assert.deepEqual(ids, [s1]);
});

test('T8: a dark channel gets one recovery run (planner with the dark context, then one evergreen slot) and one decision row; the same hour does nothing more', { skip }, async () => {
  const card = await channel();
  // The last post was 40 hours ago; the day has no plan and the planner plans nothing.
  await pool.query(`INSERT INTO published_posts (channel_id, message_id, posted_at) VALUES ($1, 1, $2)`, [card.channelKey, new Date(NOW.getTime() - 40 * HOUR)]);
  const f = build(card);
  await f.scheduler.tick(NOW);
  const evergreen = await sloRows(card.channelKey);
  assert.equal(evergreen.length, 1);
  assert.equal(evergreen[0].replaces_slot_id, null);
  assert.deepEqual({ ...evergreen[0].slo }, { replaces: null, rung: 'evergreen', cause: null, depth: 1 });
  assert.equal(f.planner.length >= 1, true, 'the planner was run for the channel');
  assert.match(f.planner.at(-1)!.extra ?? '', /Канал без постів/);
  const row = await f.repo.get(card.channelKey, DAY);
  assert.equal(row?.state, 'dark');
  assert.equal(row?.recoveryRuns, 1);
  assert.ok(row?.darkSince);
  const dec = (await pool.query(`SELECT gate, ref_type, ref_id, action, summary FROM autonomy_decisions WHERE channel_key = $1`, [card.channelKey])).rows;
  assert.equal(dec.length, 1);
  assert.deepEqual([dec[0].gate, dec[0].ref_type, dec[0].ref_id, dec[0].action], ['slo_recovery', 'channel', card.channelKey, 'applied']);
  // A second tick in the same hour: no second run, no second slot.
  await f.scheduler.tick(new Date(NOW.getTime() + 5 * 60_000));
  assert.equal((await sloRows(card.channelKey)).length, 1);
  assert.equal((await f.repo.get(card.channelKey, DAY))?.recoveryRuns, 1);
  assert.equal((await pool.query(`SELECT 1 FROM autonomy_decisions WHERE channel_key = $1`, [card.channelKey])).rowCount, 1);
  // 72 hours: not yet (dark for 16 h).
  assert.equal((await pool.query(`SELECT 1 FROM agent_inbox WHERE kind = 'channel_dark' AND ref_id LIKE $1`, [`${card.channelKey}|%`])).rowCount, 0);
});

test('FR-005: a channel dark for 3 days gets exactly one action note, whatever the number of ticks', { skip }, async () => {
  const card = await channel();
  await pool.query(`INSERT INTO published_posts (channel_id, message_id, posted_at) VALUES ($1, 1, $2)`, [card.channelKey, new Date(NOW.getTime() - 100 * HOUR)]);
  const f = build(card);
  await f.scheduler.tick(NOW);
  await f.scheduler.tick(new Date(NOW.getTime() + 3 * HOUR));
  await f.scheduler.tick(new Date(NOW.getTime() + 6 * HOUR));
  const notes = (await pool.query(`SELECT kind, severity, title, body, ref_type, ref_id FROM agent_inbox WHERE ref_id LIKE $1`, [`${card.channelKey}|%`])).rows;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'channel_dark');
  assert.equal(notes[0].severity, 'action');
  assert.equal(notes[0].title, `Channel dark for 3 days: ${card.channelKey}`);
  assert.match(notes[0].body, /Tried:/);
});

test('T8: a held channel (shadow mode) is recorded as held and gets nothing', { skip }, async () => {
  const card = await channel();
  await pool.query(`INSERT INTO published_posts (channel_id, message_id, posted_at) VALUES ($1, 1, $2)`, [card.channelKey, new Date(NOW.getTime() - 100 * HOUR)]);
  const f = build(card, { mode: 'shadow' });
  await f.scheduler.tick(NOW);
  const row = await f.repo.get(card.channelKey, DAY);
  assert.equal(row?.state, 'held');
  assert.equal(row?.target, 0);
  assert.equal((await sloRows(card.channelKey)).length, 0);
  assert.equal((await pool.query(`SELECT 1 FROM agent_inbox WHERE kind = 'channel_dark' AND ref_id LIKE $1`, [`${card.channelKey}|%`])).rowCount, 0);
});
