/**
 * Spec 091 T5/T8: the controller's decisions with every port faked (the SQL is covered by the PG test): the trigger rules of
 * FR-003, the per-tick caps of FR-010 (1 replacement and 1 recovery run per channel per tick), the dark caps and the 72-hour note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EditorCard } from '../card';
import { makeCard } from '../post/testing/fixtures';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { SloController, type SloChannelContext, type SloControllerDeps } from './slo-controller';
import type { ClosedSlot, ReplacementSpec, RungChoice, SloSlotMark } from './types';

// Friday 2026-11-06, 12:00 in Kyiv (10:00Z): plenty of the day left.
const NOW = new Date('2026-11-06T10:00:00Z');
const HOUR = 3_600_000;
const SPEC: ReplacementSpec = { format: 'text', topic: 'x' };

interface Fx {
  c: SloController; card: EditorCard;
  calls: { choose: ClosedSlot[]; insert: SloSlotMark[]; recover: number; bump: string[]; decisions: any[]; notes: any[]; rows: any[] };
  counts: { pub: number; ahead: number; skipped: number; lastPost: Date | null; marks: Array<{ rung: string; status: string; created_at: Date }> };
  slots: Map<string, Partial<EditorSlot>>;
  state: { ctx: SloChannelContext; budgetOk: boolean; choice: RungChoice | null; recoveryRuns: number; env: Record<string, string>; insertId: string | null };
}

function fx(over: Partial<Fx['state']> = {}): Fx {
  const card = { ...makeCard({ channelKey: '@c', mode: 'live', postsPerDayMin: 3, postsPerDayMax: 6 }), createdAt: new Date('2026-01-01') } as EditorCard;
  const calls: Fx['calls'] = { choose: [], insert: [], recover: 0, bump: [], decisions: [], notes: [], rows: [] };
  const counts: Fx['counts'] = { pub: 0, ahead: 1, skipped: 2, lastPost: new Date(NOW.getTime() - 5 * HOUR), marks: [] };
  const slots = new Map<string, Partial<EditorSlot>>();
  const state: Fx['state'] = {
    ctx: { mode: 'live', heldReason: null, playbookPerDay: null, ownerPausedSlots: 0 }, budgetOk: true,
    choice: { rung: 'evergreen', spec: SPEC }, recoveryRuns: 0, env: {}, insertId: 'new-slot', ...over,
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('pub_slots')) {
        return { rows: [{ channel_key: '@c', pub_slots: counts.pub, ahead: counts.ahead, skipped: counts.skipped, pub_posts: 0, last_post: counts.lastPost, last_slot: null }] };
      }
      if (sql.includes('s.slo IS NOT NULL')) return { rows: counts.marks.map((m) => ({ channel_key: '@c', ...m })) };
      if (sql.includes('replaces_slot_id IS NULL')) return { rows: [...slots.keys()].map((id) => ({ id })) };
      return { rows: [] };
    },
  };
  const deps: SloControllerDeps = {
    pool: pool as any,
    repo: {
      upsert: async (r: any) => { calls.rows.push(r); return true; },
      bump: async (_k: string, _d: string, f: string) => { calls.bump.push(f); return 1; },
      get: async () => (state.recoveryRuns ? { recoveryRuns: state.recoveryRuns, target: 0, state: 'dark' } as any : null),
    },
    inserter: { insert: async (_c, _s, mark) => { calls.insert.push(mark); return state.insertId; } },
    planner: { choose: async (_card, closed) => { calls.choose.push(closed); return state.choice; } },
    dark: { recover: async () => { calls.recover++; return { planned: 0, evergreenSlotId: null, summary: 'ran' }; } },
    env: (k) => state.env[k],
    context: async () => state.ctx,
    card: async () => card,
    slot: async (id) => (slots.get(id) as EditorSlot | undefined) ?? null,
    budget: async () => (state.budgetOk ? { ok: true } : { ok: false, reason: 'cap' }),
    inbox: { postOnce: async (i: any) => { calls.notes.push(i); return 1; } } as any,
    decisions: { record: async (d: any) => { calls.decisions.push(d); return 1; } },
  };
  return { c: new SloController(deps), card, calls, counts, slots, state };
}

const closed = (id: string, over: Partial<EditorSlot> = {}): Partial<EditorSlot> => ({
  id, channelKey: '@c', kind: 'content', status: 'skipped', error: 'no_fresh_item: nothing', format: 'text', topic: id,
  scheduledAt: new Date(NOW.getTime() - 2 * HOUR), sourceHints: [], ...over,
});

test('a behind channel gets exactly one replacement per tick, and none while one is open', async () => {
  const f = fx();
  f.slots.set('a', closed('a')); f.slots.set('b', closed('b'));
  await f.c.tick([f.card], NOW);
  assert.equal(f.calls.choose.length, 1, 'one rung choice');
  assert.equal(f.calls.insert.length, 1, 'one slot');
  assert.deepEqual(f.calls.insert[0], { replaces: 'a', rung: 'evergreen', cause: 'no_material', depth: 1 });
  assert.deepEqual(f.calls.bump, ['replacements']);
  assert.equal(f.calls.rows.at(-1).state, 'behind');
  // The open replacement now shows in the counts: the next tick asks for nothing.
  f.counts.ahead = 2; f.counts.marks = [{ rung: 'evergreen', status: 'planned', created_at: new Date(NOW.getTime() - 60_000) }];
  await f.c.tick([f.card], new Date(NOW.getTime() + 60_000));
  assert.equal(f.calls.insert.length, 1);
  assert.equal(f.calls.rows.at(-1).state, 'recovering');
});

test('FR-003 triggers: nothing for budget/config/owner closes, approval holds, a met day, a full ladder chain, a held channel or a closed budget gate', async () => {
  const cases: Array<[string, (f: Fx) => void]> = [
    ['budget close', (f) => f.slots.set('a', closed('a', { error: 'budget: cap' }))],
    ['config close', (f) => f.slots.set('a', closed('a', { error: 'preflight_format_unavailable: x' }))],
    ['owner rejected', (f) => f.slots.set('a', closed('a', { error: 'rejected by owner' }))],
    ['approval hold', (f) => f.slots.set('a', closed('a', { approvedAt: new Date(NOW.getTime() - HOUR) }))],
    ['published', (f) => f.slots.set('a', closed('a', { status: 'published' as any }))],
    ['depth 2', (f) => f.slots.set('a', closed('a', { slo: { replaces: 'z', rung: 'evergreen', cause: 'quality', depth: 2 } }))],
    ['yesterday', (f) => f.slots.set('a', closed('a', { scheduledAt: new Date(NOW.getTime() - 30 * HOUR) }))],
    ['target met', (f) => { f.slots.set('a', closed('a')); f.counts.ahead = 3; }],
    ['shadow mode', (f) => { f.slots.set('a', closed('a')); f.state.ctx.mode = 'shadow'; }],
    ['agent paused', (f) => { f.slots.set('a', closed('a')); f.state.ctx.heldReason = 'the channel agent is paused'; }],
    ['budget gate closed', (f) => { f.slots.set('a', closed('a')); f.state.budgetOk = false; }],
    ['controller off', (f) => { f.slots.set('a', closed('a')); f.state.env.SLO_CONTROLLER = 'off'; }],
  ];
  for (const [name, set] of cases) {
    const f = fx();
    set(f);
    await f.c.handleClosed('a', NOW);
    assert.equal(f.calls.insert.length, 0, name);
  }
  // The same slot with nothing in the way does get one.
  const ok = fx(); ok.slots.set('a', closed('a'));
  assert.equal(await ok.c.handleClosed('a', NOW), 'new-slot');
});

test('a close reported twice (runner hook and scheduler) gives one replacement', async () => {
  const f = fx(); f.slots.set('a', closed('a'));
  await f.c.handleClosed('a', NOW);
  await f.c.handleClosed('a', NOW);
  assert.equal(f.calls.insert.length, 1);
});

test('no rung left: the channel is starved for the day, one info note, no more tries', async () => {
  const f = fx({ choice: null });
  f.slots.set('a', closed('a')); f.slots.set('b', closed('b'));
  await f.c.tick([f.card], NOW);
  assert.equal(f.calls.choose.length, 1);
  assert.equal(f.calls.rows.at(-1).state, 'starved');
  assert.equal(f.calls.notes.length, 1);
  assert.equal(f.calls.notes[0].severity, 'info');
  await f.c.tick([f.card], new Date(NOW.getTime() + 60_000));
  assert.equal(f.calls.choose.length, 1, 'starved: the ladder is not asked again today');
  assert.equal(f.calls.rows.at(-1).state, 'starved');
});

test('a plain streak and two tried rungs make a behind channel starved', async () => {
  const f = fx();
  f.counts.marks = [{ rung: 'evergreen', status: 'skipped', created_at: NOW }, { rung: 'widen_live', status: 'skipped', created_at: NOW }];
  f.c.onPlainStreak('@c', { lastAt: new Date(NOW.getTime() - HOUR), n: 3, reason: 'no_fresh_item' } as any);
  await f.c.tick([f.card], NOW);
  assert.equal(f.calls.rows.at(-1).state, 'starved');
  assert.match(f.calls.rows.at(-1).reason, /3 plain slots/);
  assert.equal(f.calls.insert.length, 0);
});

test('a dark channel gets one recovery run per tick, at most once per SLO_DARK_HOURS and SLO_MAX_RECOVERY_RUNS_PER_DAY a day', async () => {
  const f = fx();
  f.counts.lastPost = new Date(NOW.getTime() - 30 * HOUR); f.counts.ahead = 0;
  await f.c.tick([f.card], NOW);
  assert.equal(f.calls.recover, 1);
  assert.equal(f.calls.rows.at(-1).state, 'dark');
  assert.deepEqual(f.calls.bump, ['recovery_runs']);
  assert.equal(f.calls.decisions.length, 1);
  assert.equal(f.calls.decisions[0].gate, 'slo_recovery');
  assert.equal(f.calls.decisions[0].refType, 'channel');
  assert.equal(f.calls.decisions[0].refId, '@c');
  assert.equal(f.calls.decisions[0].action, 'applied');
  await f.c.tick([f.card], new Date(NOW.getTime() + HOUR));
  assert.equal(f.calls.recover, 1, 'the same hour window: nothing');
  // The daily cap.
  const g = fx({ recoveryRuns: 3 }); g.counts.lastPost = new Date(NOW.getTime() - 30 * HOUR); g.counts.ahead = 0;
  await g.c.tick([g.card], NOW);
  assert.equal(g.calls.recover, 0, 'SLO_MAX_RECOVERY_RUNS_PER_DAY reached');
  const h = fx({ env: { SLO_MAX_RECOVERY_RUNS_PER_DAY: '0' } }); h.counts.lastPost = new Date(NOW.getTime() - 30 * HOUR); h.counts.ahead = 0;
  await h.c.tick([h.card], NOW);
  assert.equal(h.calls.recover, 0, '0 = recovery off');
  // The budget gate holds it back (the run is not counted).
  const i = fx({ budgetOk: false }); i.counts.lastPost = new Date(NOW.getTime() - 30 * HOUR); i.counts.ahead = 0;
  await i.c.tick([i.card], NOW);
  assert.equal(i.calls.recover, 0);
  assert.deepEqual(i.calls.bump, []);
});

test('dark: a held channel is not recovered; a dark one keeps the SLO_DARK_HOURS setting live', async () => {
  const held = fx({ ctx: { mode: 'live', heldReason: 'paused by the owner', playbookPerDay: null, ownerPausedSlots: 0 } });
  held.counts.lastPost = new Date(NOW.getTime() - 100 * HOUR); held.counts.ahead = 0;
  await held.c.tick([held.card], NOW);
  assert.equal(held.calls.recover, 0);
  assert.equal(held.calls.rows.at(-1).state, 'held');
  // 30 h without a post is not dark when the setting is 48.
  const f = fx({ env: { SLO_DARK_HOURS: '48' } });
  f.counts.lastPost = new Date(NOW.getTime() - 30 * HOUR); f.counts.ahead = 0;
  await f.c.tick([f.card], NOW);
  assert.equal(f.calls.recover, 0);
  assert.notEqual(f.calls.rows.at(-1).state, 'dark');
});

test('FR-005: the 72-hour action note, keyed by dark_since, only after 72 hours dark', async () => {
  const young = fx(); young.counts.lastPost = new Date(NOW.getTime() - 50 * HOUR); young.counts.ahead = 0;
  await young.c.tick([young.card], NOW);
  assert.equal(young.calls.notes.length, 0, 'dark for 26 h: only the report line');
  const f = fx(); f.counts.lastPost = new Date(NOW.getTime() - 100 * HOUR); f.counts.ahead = 0;
  await f.c.tick([f.card], NOW);
  assert.equal(f.calls.notes.length, 1);
  const n = f.calls.notes[0];
  assert.equal(n.kind, 'channel_dark');
  assert.equal(n.severity, 'action');
  assert.equal(n.title, 'Channel dark for 3 days: @c');
  const darkSince = new Date(NOW.getTime() - 100 * HOUR + 24 * HOUR).toISOString();
  assert.equal(n.refId, `@c|${darkSince}`);
  assert.equal(n.refType, 'channel_dark');
  await f.c.tick([f.card], new Date(NOW.getTime() + 2 * HOUR));
  assert.equal(f.calls.notes.at(-1).refId, n.refId, 'the same key on the next tick: the inbox dedupes it');
});

test('the note kind is not info-only (090): it stays an action note', async () => {
  const { isInfoOnlyNote } = await import('../agents/owner-inbox');
  assert.equal(isInfoOnlyNote('channel_dark'), false);
});

test('a failing port never throws out of the tick or the close event', async () => {
  const f = fx();
  (f.c as any).d.context = async () => { throw new Error('boom'); };
  const logs: string[] = [];
  (f.c as any).d.log = (m: string) => logs.push(m);
  await f.c.tick([f.card], NOW);
  f.slots.set('a', closed('a'));
  f.c.onSlotClosed('a', NOW);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(logs.length >= 2);
});
