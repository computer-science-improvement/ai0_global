// Spec 037 FR-010 (T10): dark_day / series_missed / critic_reject_streak notes on a fake clock — one note per
// resource per local day and kind; the scheduler hook; the MANAGER digest's planned vs out block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { evaluateSilentDays, rejectStreak, SilentDaysWatch, type WatchSlot } from './silent-days';
import { skipGroupOf } from './skip-reasons';
import { assembleQuality, assemblePlan, QUALITY_FLAGS, type PlanRow } from '../manager/quality-digest';
import { digestHash } from '../manager/kpi-digest.service';
import { EditorScheduler } from '../editor.scheduler';

const TZ = 'Europe/Kyiv';                       // UTC+3 in October
const at = (iso: string) => new Date(iso);
const REF = 'telegram:@birzha';

function slot(o: Partial<WatchSlot> & { id: string; scheduledAt: Date }): WatchSlot {
  return {
    ref: REF, updatedAt: o.scheduledAt, status: 'planned', error: null, format: 'text', topic: 'Тема', seriesName: null, scheduleRuleId: null,
    criticVerdict: null, fallback: null, ...o,
  };
}

/** A fake DB: the slots the watch reads, resource_tz, the orchestrators. */
function fakePool(slots: () => WatchSlot[]) {
  return {
    query: async (sql: string) => {
      if (/FROM editor_slots/.test(sql)) {
        return { rows: slots().map((s) => ({
          id: s.id, ref: s.ref, channel_key: s.ref.replace(/^telegram:/, ''), scheduled_at: s.scheduledAt, updated_at: s.updatedAt, status: s.status,
          error: s.error, format: s.format, topic: s.topic, series_name: s.seriesName, schedule_rule_id: s.scheduleRuleId, verdict: s.criticVerdict, fallback: s.fallback,
        })) };
      }
      if (/resource_tz/.test(sql)) return { rows: [{ ref: REF, tz: TZ }, { ref: 'telegram:@ai_tech', tz: TZ }] };
      if (/FROM agents/.test(sql)) return { rows: [{ scope_id: REF, id: 'orch-1' }] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

/** The Inbox's postOnce semantics: one item per kind + ref. */
function fakeInbox() {
  const items: any[] = [];
  return {
    items,
    postOnce: async (i: any) => {
      if (items.some((x) => x.kind === i.kind && x.refType === i.refType && x.refId === i.refId)) return null;
      items.push(i);
      return items.length;
    },
  };
}

test('dark_day: one note per resource per day, from 18:00 local, none before; a new note the next day', async () => {
  const data: WatchSlot[] = [
    slot({ id: 'a', scheduledAt: at('2026-10-11T07:00:00Z'), status: 'skipped', error: 'critic_rejected: reject (grounding 2): вигадано', criticVerdict: 'reject' }),
    slot({ id: 'b', scheduledAt: at('2026-10-11T11:00:00Z'), status: 'failed', error: 'budget_exceeded: channel cap' }),
  ];
  const inbox = fakeInbox();
  const watch = new SilentDaysWatch({ pool: fakePool(() => data) as any, inbox, everyMs: 0 });
  const cards = [makeCard({ channelKey: '@birzha', mode: 'live', postsPerDayMin: 2 })];

  await watch.check(cards, at('2026-10-11T14:59:00Z'));        // 17:59 Kyiv
  assert.equal(inbox.items.filter((i) => i.kind === 'dark_day').length, 0);
  await watch.check(cards, at('2026-10-11T15:00:00Z'));        // 18:00 Kyiv
  await watch.check(cards, at('2026-10-11T15:10:00Z'));
  await watch.check(cards, at('2026-10-11T20:59:00Z'));        // 23:59 Kyiv
  const dark = inbox.items.filter((i) => i.kind === 'dark_day');
  assert.equal(dark.length, 1);
  assert.deepEqual([dark[0].refType, dark[0].refId, dark[0].agentId, dark[0].severity], ['resource_day', `${REF}|2026-10-11`, 'orch-1', 'action']);
  assert.match(dark[0].body, /Planned today: 2; out: 0; not out by reason: critic 1, budget 1/);

  // Next day: no slot at all (the planner never planned) — the card's minimum still makes it a dark day.
  await watch.check(cards, at('2026-10-12T15:30:00Z'));
  const dark2 = inbox.items.filter((i) => i.kind === 'dark_day');
  assert.equal(dark2.length, 2);
  assert.equal(dark2[1].refId, `${REF}|2026-10-12`);
  assert.match(dark2[1].body, /No slot was planned today/);
});

test('dark_day: a post out, an off card, a paused resource → no note; throttled checks', async () => {
  const out = [slot({ id: 'a', scheduledAt: at('2026-10-11T07:00:00Z'), status: 'published' })];
  assert.deepEqual(evaluateSilentDays({ now: at('2026-10-11T16:00:00Z'), resources: [{ ref: REF, tz: TZ, minPerDay: 2 }], slots: out }), []);
  assert.deepEqual(evaluateSilentDays({ now: at('2026-10-11T16:00:00Z'), resources: [{ ref: REF, tz: TZ, minPerDay: 2 }], slots: [], paused: new Set([REF]) }), []);
  // A resource with no plan and no minimum (a platform resource without slots) is not a dark day.
  assert.deepEqual(evaluateSilentDays({ now: at('2026-10-11T16:00:00Z'), resources: [{ ref: 'threads:x', tz: TZ, minPerDay: 0 }], slots: [] }), []);

  const inbox = fakeInbox();
  const watch = new SilentDaysWatch({ pool: fakePool(() => []) as any, inbox });     // default throttle: 5 min
  const off = [makeCard({ channelKey: '@birzha', mode: 'off', postsPerDayMin: 2 })];
  assert.equal(await watch.check(off, at('2026-10-11T16:00:00Z')), 0);
  const on = [makeCard({ channelKey: '@birzha', mode: 'live', postsPerDayMin: 2 })];
  assert.equal(await watch.check(on, at('2026-10-11T16:01:00Z')), 0, 'throttled: the last check was a minute ago');
  assert.equal(await watch.check(on, at('2026-10-11T16:06:00Z')), 1);
});

test('series_missed: one note per resource per day listing the misses; owner decisions excluded; next day again', async () => {
  const ref = 'telegram:@ai_tech';
  const data: WatchSlot[] = [
    slot({ id: 's11', ref, scheduledAt: at('2026-10-11T09:00:00Z'), status: 'skipped', error: 'no_fresh_item: no item ≤ 12 h', seriesName: 'Три новини дня' }),
  ];
  const inbox = fakeInbox();
  const watch = new SilentDaysWatch({ pool: fakePool(() => data) as any, inbox, everyMs: 0 });
  const cards = [makeCard({ channelKey: '@ai_tech', mode: 'live', postsPerDayMin: 0 })];

  await watch.check(cards, at('2026-10-11T10:00:00Z'));
  // A second miss the same day (an owner pin at a fixed time) does not add a note.
  data.push(slot({ id: 'p11', ref, scheduledAt: at('2026-10-11T13:00:00Z'), status: 'failed', error: 'critic_failed: timeout', scheduleRuleId: 'rule-1' }));
  await watch.check(cards, at('2026-10-11T14:00:00Z'));
  // The owner's own rejection of a series slot is not a miss.
  data.push(slot({ id: 'o12', ref, scheduledAt: at('2026-10-12T09:00:00Z'), status: 'skipped', error: 'rejected by owner', seriesName: 'Три новини дня' }));
  await watch.check(cards, at('2026-10-12T10:00:00Z'));
  let notes = inbox.items.filter((i) => i.kind === 'series_missed');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].refId, `${ref}|2026-10-11`);
  assert.match(notes[0].body, /12:00 series "Три новини дня" — skipped: no_fresh_item/);
  // The next day's real miss gets its own note.
  data.push(slot({ id: 's12', ref, scheduledAt: at('2026-10-12T09:00:00Z'), status: 'skipped', error: 'critic_rejected: reject', seriesName: 'Три новини дня', criticVerdict: 'reject' }));
  await watch.check(cards, at('2026-10-12T10:30:00Z'));
  await watch.check(cards, at('2026-10-12T11:30:00Z'));
  notes = inbox.items.filter((i) => i.kind === 'series_missed');
  assert.deepEqual(notes.map((n) => n.refId), [`${ref}|2026-10-11`, `${ref}|2026-10-12`]);
});

test('critic_reject_streak: N rejections in a row (ladder attempts count); a pass breaks it; N configurable', () => {
  const t = (h: number) => at(`2026-10-11T${String(h).padStart(2, '0')}:00:00Z`);
  const rej = (id: string, h: number) => slot({ id, scheduledAt: t(h), status: 'skipped', error: 'critic_rejected: reject', criticVerdict: 'reject' });
  const ladder = slot({
    id: 'l', scheduledAt: t(9), status: 'skipped', error: 'critic_rejected: reject', criticVerdict: null,
    fallback: { steps: [
      { step: 'initial', at: '', format: 'photo', outcome: 'critic_reject', reason: 'x', verdict: 'reject', run_id: null, cost_usd: 0 },
      { step: 'next_candidate', at: '', format: 'photo', outcome: 'critic_reject', reason: 'x', verdict: 'reject', run_id: null, cost_usd: 0 },
    ], final: null },
  });
  assert.equal(rejectStreak([rej('a', 7), ladder]).n, 3);
  assert.equal(rejectStreak([rej('a', 7), slot({ id: 'p', scheduledAt: t(8), status: 'published', criticVerdict: 'pass' }), rej('b', 10)]).n, 1);
  // A critic outage or a post that never reached the critic does not break or extend the streak.
  assert.equal(rejectStreak([rej('a', 7), slot({ id: 'e', scheduledAt: t(8), status: 'failed', error: 'critic_failed', criticVerdict: 'error' }), rej('b', 10)]).n, 2);
  const now = at('2026-10-11T12:00:00Z');
  const res = [{ ref: REF, tz: TZ, minPerDay: 0 }];
  const three = [rej('a', 7), rej('b', 8), rej('c', 10)];
  assert.equal(evaluateSilentDays({ now, resources: res, slots: three }).filter((a) => a.kind === 'critic_reject_streak').length, 1);
  assert.equal(evaluateSilentDays({ now, resources: res, slots: three, streakN: 4 }).filter((a) => a.kind === 'critic_reject_streak').length, 0);
  const a = evaluateSilentDays({ now, resources: res, slots: three })[0];
  assert.deepEqual([a.day, a.slotIds], ['2026-10-11', ['c', 'b', 'a']]);
});

test('scheduler: the silent-day hook runs every tick with the cards and the paused refs', async () => {
  const calls: any[] = [];
  const card = { ...makeCard({ channelKey: '@birzha', mode: 'live' }), createdAt: new Date('2026-01-01T00:00:00Z') };
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [card] },
    plans: {
      getActivePlan: async () => ({ rationale: 'plan' }) as any, claimDue: async () => [], skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0,
    },
    runner: { runPlanner: async () => ({}) as any, runExecutor: async () => ({}) as any, runReviewer: async () => ({}) as any },
    enabled: () => true, notify: async () => {},
    pauses: { liftDue: async () => 0, pausedRefs: async () => new Set(['threads:x']), held: async () => false },
    silentDays: async (cards, now, paused) => { calls.push([cards.map((c) => c.channelKey), now.toISOString(), [...paused]]); },
  });
  await s.tick(at('2026-10-11T15:00:00Z'));
  assert.deepEqual(calls, [[['@birzha'], '2026-10-11T15:00:00.000Z', ['threads:x']]]);
});

// ── MANAGER digest ──────────────────────────────────────────────────────────

const row = (o: Partial<PlanRow> & { slotId: string; at: Date; status: string }): PlanRow =>
  ({ error: null, criticVerdict: null, seriesName: null, scheduleRuleId: null, fallback: null, ...o });

test('digest: planned vs published per local day, skip reasons grouped, dark_day and series_missed flags', () => {
  const rows: PlanRow[] = [
    row({ slotId: '1', at: at('2026-10-10T06:00:00Z'), status: 'published' }),
    row({ slotId: '2', at: at('2026-10-10T09:00:00Z'), status: 'skipped', error: 'critic_rejected: reject', criticVerdict: 'reject',
      fallback: { steps: [{ step: 'initial', at: '', format: 'photo', outcome: 'critic_reject', reason: 'x', verdict: 'reject', run_id: null, cost_usd: 0 }], final: { outcome: 'skipped', code: 'exhausted', step: 'lighter_format', reason: 'x' } } }),
    row({ slotId: '3', at: at('2026-10-11T06:00:00Z'), status: 'skipped', error: 'critic_rejected: reject', criticVerdict: 'reject' }),
    row({ slotId: '4', at: at('2026-10-11T09:00:00Z'), status: 'skipped', error: 'no_fresh_item: nothing', seriesName: 'Три новини дня' }),
    row({ slotId: '5', at: at('2026-10-11T12:00:00Z'), status: 'failed', error: 'lint_failed: caption_too_long' }),
    row({ slotId: '6', at: at('2026-10-11T13:00:00Z'), status: 'failed', error: 'budget_exceeded: channel cap' }),
    row({ slotId: '7', at: at('2026-10-11T14:00:00Z'), status: 'skipped', error: 'daily_cap_reached: 5/5' }),
    row({ slotId: '8', at: at('2026-10-11T15:00:00Z'), status: 'skipped', error: 'superseded by a new plan' }),
    row({ slotId: '9', at: at('2026-10-12T06:00:00Z'), status: 'shadowed',
      fallback: { steps: [], final: { outcome: 'rescued', code: 'shadowed', step: 'next_candidate', reason: null } } }),
    row({ slotId: '10', at: at('2026-10-12T16:00:00Z'), status: 'planned' }),
  ];
  // 12.10 18:30 Kyiv.
  const p = assemblePlan(rows, TZ, at('2026-10-12T15:30:00Z'));
  assert.deepEqual(p.days.map((d) => [d.day, d.planned, d.published, d.shadowed, d.pending]), [
    ['2026-10-10', 2, 1, 0, 0], ['2026-10-11', 5, 0, 0, 0], ['2026-10-12', 2, 0, 1, 1],
  ]);
  assert.deepEqual(p.days[1].skip_reasons, { critic: 1, nothing_fresh: 1, lint: 1, budget: 1, cap: 1 });
  assert.deepEqual(p.dark_days, ['2026-10-11']);
  assert.deepEqual(p.series_missed.map((m) => [m.day, m.slot_id, m.series]), [['2026-10-11', '4', 'Три новини дня']]);
  assert.deepEqual(p.fallback, { laddered: 1, rescued: 0 }, 'a ladder with no steps recorded is not counted');

  const base = { critic: [], posts: [], owner: [], caps: { pollsPerWeek: null, questionsPerDay: 1 } as any };
  const q = assembleQuality({ ...base, plan: { rows, tz: TZ, now: at('2026-10-12T15:30:00Z') } });
  assert.ok(q.flags.includes('dark_day') && q.flags.includes('series_missed'));
  assert.ok(QUALITY_FLAGS.includes('dark_day') && QUALITY_FLAGS.includes('series_missed'));
  assert.equal(q.signature.silent, '2026-10-11|4');
  // Without the plan rows (the directive verification window), the block is unchanged.
  assert.equal(assembleQuality(base).plan, undefined);
  assert.equal(assembleQuality(base).signature.silent, undefined);
});

test('digest: a new dark day changes the hash (the MANAGER run is not skipped); the same data keeps it', () => {
  const caps = { pollsPerWeek: null, questionsPerDay: 1 } as any;
  const day1 = [row({ slotId: '1', at: at('2026-10-11T06:00:00Z'), status: 'skipped', error: 'critic_rejected: x', criticVerdict: 'reject' })];
  const day2 = [...day1, row({ slotId: '2', at: at('2026-10-12T06:00:00Z'), status: 'skipped', error: 'critic_rejected: x', criticVerdict: 'reject' })];
  const dg = (rows: PlanRow[], now: Date) => ({
    resources: [{ ref: REF, title: null, agent: null, health: null, kpis: {} as any, anomalies: [], quality: assembleQuality({ critic: [], posts: [], owner: [], caps, plan: { rows, tz: TZ, now } }) }],
    directives: { open: [], outcomes: [] },
  });
  const h1 = digestHash(dg(day1, at('2026-10-12T08:00:00Z')));
  assert.equal(h1, digestHash(dg(day1, at('2026-10-12T09:00:00Z'))));
  // 12.10 at 18:00 Kyiv the new day is dark too: the flags stay the same, the signature changes.
  const h2 = digestHash(dg(day2, at('2026-10-12T15:30:00Z')));
  assert.notEqual(h1, h2);
});

test('skip groups: stable prefixes of every skip path', () => {
  assert.equal(skipGroupOf('critic_failed: timeout'), 'critic');
  assert.equal(skipGroupOf('skipped by agent: не врятувати', 'revise'), 'critic');
  assert.equal(skipGroupOf('skipped by agent: нічого цікавого', null), 'other');
  assert.equal(skipGroupOf('too_similar: схожість 0.7'), 'lint');
  assert.equal(skipGroupOf('quiet_hours'), 'cap');
  assert.equal(skipGroupOf('series "X": required source library:pdr has nothing left on telegram:@x'), 'nothing_fresh');
  assert.equal(skipGroupOf('stale: missed its time window'), 'other');
});
