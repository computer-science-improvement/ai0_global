// Spec 091 FR-005: dark recovery — reset the tries, a planner run with a recovery context, one evergreen slot when it plans nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { DarkRecoveryService, recoveryContext, type DarkRecoveryDeps } from './dark-recovery';
import { RecoveryLadder, type LadderStore } from './recovery-ladder';
import type { DarkContext, ReplacementSpec, SloSlotMark } from './types';

const NOW = new Date('2026-11-07T12:00:00Z');
const ctx: DarkContext = { darkSince: new Date('2026-11-06T06:00:00Z'), lastSkips: ['no_fresh_item', 'source_unreachable: 403', 'critic_rejected', 'a', 'b', 'c-extra'], target: 2, runsToday: 0 };

function setup(o: { planned?: number | Error; used?: number; insertId?: string | null; env?: Record<string, string> } = {}) {
  const calls: string[] = [];
  let ctxText = '';
  const inserted: Array<{ spec: ReplacementSpec; mark: SloSlotMark }> = [];
  const store: LadderStore = {
    seriesWithRunway: async () => [], okSources: async () => [], isDark: async () => true,
    evergreenToday: async () => o.used ?? 0,
  };
  const env = (k: string) => o.env?.[k];
  const deps: DarkRecoveryDeps = {
    resetPlannerTries: (ch) => { calls.push(`reset:${ch}`); },
    runPlanner: async (_c, text) => { calls.push('plan'); ctxText = text; if (o.planned instanceof Error) throw o.planned; return o.planned ?? 0; },
    inserter: { insert: async (_c, spec, mark) => { calls.push('insert'); inserted.push({ spec, mark }); return o.insertId === undefined ? 'slot-e' : o.insertId; } },
    ladder: new RecoveryLadder({ store, env }),
    pool: { query: async () => ({ rows: [{ format: 'text', url: 'https://www.nasa.gov/a' }, { format: 'text', url: 'https://nasa.gov/b' }, { format: 'photo', url: 'https://esa.int/c' }] }) } as any,
    env, log: () => {},
  };
  return { svc: new DarkRecoveryService(deps), calls, inserted, ctxText: () => ctxText };
}

test('planner plans slots: tries reset first, no evergreen, summary names the count', async () => {
  const t = setup({ planned: 2 });
  const r = await t.svc.recover(makeCard({ channelKey: '@chan' }), ctx, NOW);
  assert.deepEqual(t.calls, ['reset:@chan', 'plan']);
  assert.equal(r.planned, 2);
  assert.equal(r.evergreenSlotId, null);
  assert.match(r.summary, /planned 2 slots/);
});

test('the planner context names the dark reason, the last 5 skips and the 14-day formats and hosts', async () => {
  const t = setup({ planned: 1 });
  await t.svc.recover(makeCard(), ctx, NOW);
  const text = t.ctxText();
  assert.match(text, /no post for about 30 h/);
  assert.match(text, /no_fresh_item/);
  assert.doesNotMatch(text, /c-extra/, 'only the last 5 skips');
  assert.match(text, /Formats that published in the last 14 days: text, photo/);
  assert.match(text, /nasa\.gov, esa\.int/);
  assert.match(text, /Plan at least the target; prefer formats and sources that published in the last 14 days\./);
});

test('recoveryContext copes with no skips and no history', () => {
  const s = recoveryContext({ darkSince: ctx.darkSince, lastSkips: [], target: 1 }, { formats: [], hosts: [] }, NOW);
  assert.match(s, /No recent skip reasons/);
  assert.match(s, /last 14 days: none/);
});

test('0 slots planned: one evergreen slot with the recovery mark', async () => {
  const t = setup({ planned: 0 });
  const r = await t.svc.recover(makeCard(), ctx, NOW);
  assert.deepEqual(t.calls, ['reset:@chan', 'plan', 'insert']);
  assert.equal(r.evergreenSlotId, 'slot-e');
  assert.equal(r.planned, 0);
  assert.deepEqual(t.inserted[0].mark, { replaces: null, rung: 'evergreen', cause: null, depth: 1 });
  assert.equal(t.inserted[0].spec.topicMode, 'fixed');
  assert.match(r.summary, /planned nothing.*evergreen slot was added/);
});

test('the planner throws: same evergreen fallback, error in the summary', async () => {
  const t = setup({ planned: new Error('llm down') });
  const r = await t.svc.recover(makeCard(), ctx, NOW);
  assert.equal(r.evergreenSlotId, 'slot-e');
  assert.match(r.summary, /planner failed \(llm down\)/);
});

test('no room in the day: evergreen slot id is null and the summary says so', async () => {
  const t = setup({ planned: 0, insertId: null });
  const r = await t.svc.recover(makeCard(), ctx, NOW);
  assert.equal(r.evergreenSlotId, null);
  assert.match(r.summary, /no evergreen slot fit/);
});

test('the dark evergreen cap is respected: used cap, or SLO_EVERGREEN_DARK_MAX=0, adds no slot', async () => {
  const full = setup({ planned: 0, used: 2 });
  const r = await full.svc.recover(makeCard(), ctx, NOW);
  assert.equal(r.evergreenSlotId, null);
  assert.ok(!full.calls.includes('insert'));
  assert.match(r.summary, /cap is used \(2\/2\)/);
  const off = setup({ planned: 0, env: { SLO_EVERGREEN_DARK_MAX: '0' } });
  assert.match((await off.svc.recover(makeCard(), ctx, NOW)).summary, /SLO_EVERGREEN_DARK_MAX=0/);
  assert.ok(!off.calls.includes('insert'));
});

test('a failing history query does not stop the recovery', async () => {
  const t = setup({ planned: 1 });
  (t.svc as any).d.pool = { query: async () => { throw new Error('db'); } };
  assert.equal((await t.svc.recover(makeCard(), ctx, NOW)).planned, 1);
});
