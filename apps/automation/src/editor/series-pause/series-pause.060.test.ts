// Spec 060 FR-001 / FR-002 on fakes: the cause classes, the streak counter (owner and budget skips excluded, threshold 0 = off,
// a resume starts a new count), the breaker (one pause and one note for the review-3 prompts run, planned slots skipped),
// and what the planners see (paused series are a plan error, the last skip reasons are in the prompt block).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClose, skipsUk } from './skip-cause';
import { pauseMapKey, skipStreaks, type StreakSlot } from './streak';
import { pausedNote, recentSkips, SeriesBreaker } from './series-breaker';
import { skipLine, type SeriesPause } from './series-pauses.repository';
import { PlannerPauseView } from './planner-view';
import { planScheduleErrors, scheduleBlock, dueInstances, type PlanScheduleCtx } from '../schedule/plan-schedule-rules';
import { PlaybookSchema } from '../network/playbook';
import { isNotAMiss } from '../silent/skip-reasons';
import { makeCard } from '../post/testing/fixtures';
import { EditorScheduler } from '../editor.scheduler';

const CH = '@ai0_prompts_dev';
const H = 3600_000;
const T0 = Date.parse('2026-10-15T09:00:00Z');

let n = 0;
function slot(o: Partial<StreakSlot> & { status?: string; error?: string | null; hoursAgo?: number }): StreakSlot {
  const at = new Date(Date.parse('2026-10-22T09:00:00Z') - (o.hoursAgo ?? 0) * H);
  n++;
  return {
    id: `s${n}`, channelKey: CH, resourceRef: null, seriesName: 'Prompt', scheduleRuleId: null, topic: 'Промпт дня',
    scheduledAt: at, updatedAt: at, status: 'skipped', error: null, criticVerdict: null, ...o,
  };
}
const NO_TEXT = 'skipped by agent: у рядках немає повного тексту промпту';

test('cause classes: stable codes, free text, pre-flight prefixes, ignored skips', () => {
  const cause = (error: string | null, status = 'skipped', criticVerdict: string | null = null) => classifyClose({ status, error, criticVerdict });
  assert.deepEqual(cause('no_fresh_item: нічого свіжого'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause('source_already_posted: https://zakon.rada.gov.ua/laws/show/1306-2001-п'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause('max_steps: no result; last tool error source_already_posted'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause('series "Prompt": required source library:prompts has nothing left on telegram:@x'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause(NO_TEXT), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause('skipped by agent: PromptHero page gives a truncated prompt'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause('skipped by agent: web_fetch 403 on the source'), { k: 'cause', cause: 'source_unreachable' });
  assert.deepEqual(cause('skipped by agent: сторінка недоступна, таймаут'), { k: 'cause', cause: 'source_unreachable' });
  assert.deepEqual(cause('host_blocked: marktechpost.com'), { k: 'cause', cause: 'source_unreachable' });
  assert.deepEqual(cause('critic_rejected: number_not_in_sources'), { k: 'cause', cause: 'critic' });
  assert.deepEqual(cause('skipped by agent: переписав', 'skipped', 'revise'), { k: 'cause', cause: 'critic' });
  // Spec 061 codes classify by prefix.
  assert.deepEqual(cause('preflight_source_used: джерело вже використано'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause('preflight_stale: ідея застаріла'), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(cause('preflight_host_blocked: host'), { k: 'cause', cause: 'source_unreachable' });
  assert.deepEqual(cause('preflight_format_unavailable: carousel'), { k: 'ignore' });
  // Never counted: owner decisions, budget, the breaker's own skips, superseded plans, expired approvals.
  assert.deepEqual(cause('rejected by owner'), { k: 'ignore' });
  assert.deepEqual(cause('resource_paused'), { k: 'ignore' });
  assert.deepEqual(cause('budget: daily cap'), { k: 'ignore' });
  assert.deepEqual(cause('budget_exceeded'), { k: 'ignore' });
  assert.deepEqual(cause('series_paused: "Prompt" is paused'), { k: 'ignore' });
  assert.deepEqual(cause('superseded by a new plan'), { k: 'ignore' });
  assert.deepEqual(cause(null, 'expired'), { k: 'ignore' });
  assert.deepEqual(cause(null, 'published'), { k: 'out' });
  assert.deepEqual(cause(null, 'awaiting_approval'), { k: 'out' });
  assert.deepEqual(cause('lint_failed: x'), { k: 'other' });
  assert.ok(isNotAMiss('series_paused: x'), 'a paused skip is not a missed series for the silent-day notes');
});

test('streak: the trailing run of one cause; a post, another cause or an unclassified skip ends it', () => {
  const o = { threshold: 3 };
  const run = (...rows: Array<Partial<StreakSlot>>) => skipStreaks(rows.map((r, i) => slot({ hoursAgo: (rows.length - i) * 5, ...r })), o);
  assert.equal(run({ error: NO_TEXT }, { error: NO_TEXT }).length, 0, 'two are not enough');
  const hit = run({ error: NO_TEXT }, { error: NO_TEXT }, { error: NO_TEXT });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].n, 3);
  assert.equal(hit[0].cause, 'no_material');
  assert.equal(hit[0].key, 'series:Prompt');
  assert.match(hit[0].reason, /немає повного тексту/);
  assert.ok(!/^skipped by agent/.test(hit[0].reason), 'the prefix is dropped from the reason');
  // A post in between ends the run; the older skips do not count.
  assert.equal(run({ error: NO_TEXT }, { error: NO_TEXT }, { status: 'published' }, { error: NO_TEXT }, { error: NO_TEXT }).length, 0);
  // Spec 068 FR-003: for a series the three material causes are one family (an unreadable source in between does not end the run) ...
  const mixed = run({ error: NO_TEXT }, { error: 'host_blocked: x' }, { error: NO_TEXT }, { error: NO_TEXT });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].n, 4);
  assert.equal(mixed[0].cause, 'no_material');
  // ... an unclassified skip (or a quality skip) still ends it.
  assert.equal(run({ error: NO_TEXT }, { error: NO_TEXT }, { error: 'lint_failed: x' }, { error: NO_TEXT }).length, 0);
  // Owner and budget skips are transparent: they neither count nor break.
  const t = run({ error: NO_TEXT }, { error: 'rejected by owner' }, { error: NO_TEXT }, { error: 'budget: cap' }, { error: NO_TEXT });
  assert.equal(t.length, 1);
  assert.equal(t[0].n, 3);
  // Only closed slots count: a planned slot after the run does not break it.
  assert.equal(run({ error: NO_TEXT }, { error: NO_TEXT }, { error: NO_TEXT }, { status: 'planned' }).length, 1);
  // Spec 068 FR-003: critic closes are transparent — a critic streak is no hit (it keeps critic_reject_streak), and a critic close neither counts nor ends a run.
  assert.equal(run({ error: 'critic_rejected: x' }, { error: 'critic_rejected: x' }, { error: 'critic_rejected: x' }).length, 0);
  const withCritic = run({ error: NO_TEXT }, { error: 'critic_rejected: x' }, { error: NO_TEXT }, { error: 'critic_rejected: x' }, { error: NO_TEXT });
  assert.equal(withCritic.length, 1);
  assert.equal(withCritic[0].n, 3);
  assert.deepEqual(withCritic[0].slotIds.length, 3);
});

test('streak: threshold 0 is off; other series and channels are counted apart; a resume starts a new count', () => {
  const rows = [slot({ error: NO_TEXT, hoursAgo: 30 }), slot({ error: NO_TEXT, hoursAgo: 20 }), slot({ error: NO_TEXT, hoursAgo: 10 })];
  assert.deepEqual(skipStreaks(rows, { threshold: 0 }), []);
  assert.equal(skipStreaks(rows, { threshold: 3 }).length, 1);
  assert.equal(skipStreaks(rows, { threshold: 4 }).length, 0);
  const mixed = [rows[0], rows[1], slot({ error: NO_TEXT, hoursAgo: 10, seriesName: 'Other' }), slot({ error: NO_TEXT, hoursAgo: 9, channelKey: '@other' })];
  assert.equal(skipStreaks(mixed, { threshold: 3 }).length, 0, 'a streak is per series and channel');
  const resumed = new Map([[pauseMapKey(CH, 'series:Prompt'), new Date(rows[1].updatedAt.getTime() + 1)]]);
  assert.equal(skipStreaks(rows, { threshold: 3, resumedAt: resumed }).length, 0, 'slots closed before the resume do not count');
  assert.equal(skipStreaks([...rows, slot({ error: NO_TEXT, hoursAgo: 5 }), slot({ error: NO_TEXT, hoursAgo: 4 })], { threshold: 3, resumedAt: resumed })[0].n, 3);
});

test('streak: an owner pin groups by its rule, plain slots by the resource and need 20 hours of span', () => {
  const rule = (h: number) => slot({ seriesName: null, scheduleRuleId: 'rule-1', error: 'no_fresh_item: x', hoursAgo: h });
  const hit = skipStreaks([rule(30), rule(20), rule(10)], { threshold: 3 });
  assert.equal(hit[0].key, 'rule:rule-1');
  assert.equal(hit[0].kind, 'rule');
  const plain = (h: number, ref: string | null = null) => slot({ seriesName: null, resourceRef: ref, error: 'no_fresh_item: x', hoursAgo: h });
  assert.equal(skipStreaks([plain(3), plain(2), plain(1)], { threshold: 3 }).length, 0, 'one quiet evening is not a dead resource');
  const r = skipStreaks([plain(60), plain(30), plain(2)], { threshold: 3 });
  assert.equal(r[0].key, `resource:telegram:${CH}`);
  assert.equal(skipStreaks([plain(60, 'instagram:abc'), plain(30, 'instagram:abc'), plain(2, 'instagram:abc')], { threshold: 3 })[0].key, 'resource:instagram:abc');
});

/** An in-memory repo + Inbox for the breaker. */
function fixture(slots: StreakSlot[], threshold = 3) {
  const pauses: SeriesPause[] = [];
  const notes: any[] = [];
  const skipped: string[] = [];
  const repo = {
    closedSlots: async () => slots,
    lastResumes: async () => new Map<string, Date>(),
    open: async () => pauses.filter((p) => !p.resumedAt),
    insertOpen: async (p: any) => {
      if (pauses.some((x) => !x.resumedAt && x.channelKey === p.channelKey && x.key === p.key)) return null;
      const row: SeriesPause = { id: `p${pauses.length + 1}`, channelKey: p.channelKey, key: p.key, label: p.label, cause: p.cause, reason: p.reason, streak: p.streak, pausedAt: new Date(), resumedAt: null, resumedBy: null };
      pauses.push(row);
      return row;
    },
    skipPlanned: async (p: any) => { skipped.push(p.key); return 1; },
    agentOf: async () => 'agent-1',
  };
  const breaker = new SeriesBreaker({ repo, inbox: { post: async (i: any) => { notes.push(i); return notes.length; } }, threshold: () => threshold, everyMs: 0 });
  return { breaker, pauses, notes, skipped };
}

test('review-3 replay: 12 skipped prompts slots make one pause and one note, not ten', async () => {
  const slots = Array.from({ length: 12 }, (_, i) => slot({ hoursAgo: (12 - i) * 12, error: NO_TEXT }));
  const f = fixture(slots);
  const now = new Date('2026-10-22T10:00:00Z');
  assert.equal(await f.breaker.check(now), 1);
  for (let i = 0; i < 5; i++) assert.equal(await f.breaker.check(now), 0, 'the next ticks add nothing');
  assert.equal(f.pauses.length, 1);
  assert.equal(f.notes.length, 1);
  const note = f.notes[0];
  assert.equal(note.kind, 'series_paused');
  assert.equal(note.severity, 'action');
  assert.equal(note.refType, 'series_pause');
  assert.equal(note.refId, 'p1');
  assert.equal(note.agentId, 'agent-1');
  assert.match(note.alert.title, /Призупинено серію "Prompt" на @ai0_prompts_dev: 12 пропусків поспіль/);
  assert.match(note.alert.body, /немає повного тексту промпту/);
  assert.match(note.title, /^Series "Prompt" on @ai0_prompts_dev paused/);
  assert.ok(!/[а-яіїєґ]/i.test(`${note.title}${note.body}`.replace(/Last reason: .*/g, '')), 'stored note text is English');
  assert.deepEqual(f.skipped.slice(0, 1), ['series:Prompt'], 'the planned slots of a paused series are skipped');
  assert.ok(f.skipped.length >= 6, 'and again on every tick (new slots)');
});

test('breaker: threshold 0 pauses nothing but still enforces an open pause; critic streaks are not paused', async () => {
  const dead = [1, 2, 3].map((i) => slot({ hoursAgo: i * 10, error: NO_TEXT }));
  const off = fixture(dead, 0);
  assert.equal(await off.breaker.check(new Date()), 0);
  assert.equal(off.pauses.length, 0);
  assert.equal(off.notes.length, 0);

  const critic = fixture([1, 2, 3, 4].map((i) => slot({ hoursAgo: i * 10, error: 'critic_rejected: x' })));
  assert.equal(await critic.breaker.check(new Date()), 0);
  assert.equal(critic.pauses.length, 0);

  const on = fixture(dead, 3);
  await on.breaker.check(new Date());
  assert.equal(on.pauses.length, 1);
  on.pauses[0].resumedAt = new Date();                                             // resumed
  assert.equal((await on.breaker.check(new Date())), 1, 'without a resume cutoff the same streak pauses again (the real repo passes the last resume)');
});

test('the Ukrainian wording and plural forms', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 11, 12, 21, 22, 25].map(skipsUk), ['пропуск', 'пропуски', 'пропуски', 'пропуски', 'пропусків', 'пропусків', 'пропусків', 'пропуск', 'пропуски', 'пропусків']);
  const p: SeriesPause = { id: 'p', channelKey: '@x', key: 'series:Prompt', label: 'Prompt', cause: 'no_material', reason: 'у рядках немає повного тексту промпту', streak: 3, pausedAt: new Date(), resumedAt: null, resumedBy: null };
  assert.equal(pausedNote(p).alert.title, 'Призупинено серію "Prompt" на @x: 3 пропуски поспіль');
  const res = pausedNote({ ...p, key: 'resource:telegram:@x', label: 'telegram:@x' });
  assert.match(res.alert.title, /^Призупинено планування telegram:@x/);
});

const clocks = { [`telegram:${CH}`]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 7 }, gapMin: 30 } };
function planCtx(over: Partial<PlanScheduleCtx>): PlanScheduleCtx {
  return {
    planDate: '2026-10-22', defaultRef: `telegram:${CH}`, now: new Date('2026-10-22T05:00:00Z'), clocks, rules: [], pins: [],
    series: PlaybookSchema.parse({
      platforms: [{ resource_ref: `telegram:${CH}`, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 4 } }],
      series: [{ name: 'Prompt', cadence: 'daily@12:00', resource_ref: `telegram:${CH}`, format: 'text', brief: 'Промпт дня з бібліотеки' }],
    }).series ?? [],
    checkSlotSeries: true, ...over,
  } as PlanScheduleCtx;
}
const plan = (slots: Array<{ time: string; series?: string }>) => ({ slots: slots.map((s) => ({ ...s, source_hints: [] as string[] })), skipped_series: [] });

test('the planners: a paused series is not due, a slot of it is a plan error, the prompt block says why', () => {
  const free = planCtx({});
  assert.ok(dueInstances(free).some((d) => d.series.name === 'Prompt'), 'sanity: the series is due without a pause');
  const paused = planCtx({ paused: [{ name: 'Prompt', resourceRef: null, label: 'Prompt', streak: 3, reason: 'no_material: у рядках немає повного тексту' }] });
  assert.ok(!dueInstances(paused).some((d) => d.series.name === 'Prompt'));
  assert.deepEqual(planScheduleErrors(plan([{ time: '15:00' }]), paused, `telegram:${CH}`), [], 'the paused series needs no slot and no skipped_series');
  const errs = planScheduleErrors(plan([{ time: '12:00', series: 'Prompt' }]), paused, `telegram:${CH}`);
  assert.ok(errs.some((e) => /серія «Prompt» на паузі \(3 пропуски поспіль/.test(e)), errs.join('\n'));
  const block = scheduleBlock(paused)!;
  assert.match(block, /серія «Prompt» НА ПАУЗІ: 3 пропуски поспіль/);
  assert.equal(scheduleBlock(paused, false), null, 'the second day of the planner block leaves the pause lines out');
  const withSkips = scheduleBlock(planCtx({ recentSkips: [{ label: 'Prompt', lines: ['skipped: a', 'no_fresh_item: b'] }] }))!;
  assert.match(withSkips, /останні пропуски «Prompt»: 1\) skipped: a; 2\) no_fresh_item: b/);
  // A paused resource: plain slots there are refused, series slots are judged by their own pause.
  const res = planCtx({ paused: [{ name: null, resourceRef: `telegram:${CH}`, label: `telegram:${CH}`, streak: 4, reason: '' }] });
  assert.ok(planScheduleErrors(plan([{ time: '15:00' }]), res, `telegram:${CH}`).some((e) => /планування telegram:@ai0_prompts_dev на паузі/.test(e)));
});

test('FR-002: the last 3 skip reasons per series, only for series whose latest slot was a skip', () => {
  const rows = [
    slot({ hoursAgo: 50, error: 'no_fresh_item: a' }), slot({ hoursAgo: 40, error: NO_TEXT }), slot({ hoursAgo: 30, error: 'source_already_posted: https://x' }),
    slot({ hoursAgo: 20, error: 'host_blocked: y' }),
    slot({ hoursAgo: 10, seriesName: 'Works', status: 'skipped', error: 'no_fresh_item: z' }), slot({ hoursAgo: 5, seriesName: 'Works', status: 'published' }),
    slot({ hoursAgo: 8, seriesName: 'Owned', error: 'rejected by owner' }),
  ];
  const r = recentSkips(rows);
  assert.deepEqual(r.filter((x) => x.key === 'series:Prompt').map((x) => x.line.slice(0, 20)), ['skipped: у рядках не', 'source_already_poste', 'host_blocked: y']);
  assert.ok(r.every((x) => x.key !== 'series:Works'), 'a series that posted since is not listed');
  assert.ok(r.every((x) => x.key !== 'series:Owned'), 'owner decisions are not skip reasons');
  assert.ok(r.every((x) => x.line.length <= 160));
  assert.equal(skipLine(`skipped by agent: ${'я'.repeat(300)}`).length, 160);
});

test('PlannerPauseView: open pauses of the channel and the recent skips of the series that are not paused', async () => {
  const open: SeriesPause[] = [
    { id: 'p1', channelKey: CH, key: 'series:Prompt', label: 'Prompt', cause: 'no_material', reason: 'r', streak: 3, pausedAt: new Date(), resumedAt: null, resumedBy: null },
    { id: 'p2', channelKey: CH, key: 'rule:abc', label: 'fixed slot "x"', cause: 'owner', reason: '', streak: 0, pausedAt: new Date(), resumedAt: null, resumedBy: null },
    { id: 'p3', channelKey: CH, key: `resource:telegram:${CH}`, label: `telegram:${CH}`, cause: 'no_material', reason: '', streak: 4, pausedAt: new Date(), resumedAt: null, resumedBy: null },
  ];
  const view = new PlannerPauseView({
    open: async () => open,
    closedSlots: async () => [slot({ hoursAgo: 9, error: NO_TEXT }), slot({ hoursAgo: 8, seriesName: 'Other', error: 'no_fresh_item: x' })],
  });
  const v = await view.forChannel(CH, new Date());
  assert.deepEqual(v.paused.map((p) => [p.name, p.resourceRef]), [['Prompt', null], [null, `telegram:${CH}`]], 'a pinned rule is the owner\'s: not told to the planner');
  assert.deepEqual(v.recentSkips.map((x) => x.label), ['Other'], 'a paused series is not repeated as a skip list');
});

test('scheduler: the breaker runs every tick before slots are claimed; a channel with paused plain slots is not planned', async () => {
  const order: string[] = [];
  const planned: string[] = [];
  const mk = (channelKey: string) => ({ ...makeCard({ channelKey, mode: 'live', planHour: 0 }), createdAt: new Date('2026-01-01T00:00:00Z') });
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [mk('@dead'), mk('@alive')] },
    plans: {
      getActivePlan: async () => null, claimDue: async () => { order.push('claim'); return []; }, skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0,
    },
    runner: { runPlanner: async (c: any) => { planned.push(c.channelKey); return {} as any; }, runExecutor: async () => ({}) as any, runReviewer: async () => ({}) as any },
    enabled: () => true, notify: async () => {},
    seriesPauses: { check: async () => { order.push('check'); }, plainPaused: async () => new Set(['@dead']) },
  });
  await s.tick(new Date('2026-10-22T09:00:00Z'));
  assert.deepEqual(order, ['check', 'claim']);
  assert.deepEqual(planned, ['@alive']);
  // A failing breaker never stops the tick.
  const logs: string[] = [];
  const s2 = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any, channels: { listActive: async () => [] },
    plans: { getActivePlan: async () => null, claimDue: async () => { order.push('claim2'); return []; }, skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0 },
    runner: { runPlanner: async () => ({}) as any, runExecutor: async () => ({}) as any, runReviewer: async () => ({}) as any },
    enabled: () => true, notify: async () => {}, log: (m) => logs.push(m),
    seriesPauses: { check: async () => { throw new Error('db down'); }, plainPaused: async () => { throw new Error('db down'); } },
  });
  await s2.tick(new Date());
  assert.ok(order.includes('claim2'));
  assert.equal(logs.length, 2);
});
