/**
 * Spec 091 T2/T8 (unit, fakes): the scheduler with the SLO controller. T2 pins the `plainPaused` gate of 060 (the flag off keeps it)
 * and the new behaviour (the gate is gone, the channel keeps planning). The end-to-end replacement of a skipped plain slot against
 * a real database is in `slo/slo-flow.091.pg.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorScheduler, type EditorSchedulerDeps } from './editor.scheduler';
import { makeCard } from './post/testing/fixtures';

const mk = (channelKey: string) => ({ ...makeCard({ channelKey, mode: 'live', planHour: 0 }), createdAt: new Date('2026-01-01T00:00:00Z') });
const NOW = new Date('2026-11-06T09:00:00Z');

function setup(o: { slo?: EditorSchedulerDeps['slo']; due?: any[]; staleIds?: string[]; triesFloor?: EditorSchedulerDeps['triesFloor']; pool?: any } = {}) {
  const order: string[] = [];
  const planned: Array<{ ch: string; extra?: string | null }> = [];
  const logs: string[] = [];
  const s = new EditorScheduler({
    pool: o.pool ?? { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [mk('@dead'), mk('@alive')] },
    plans: {
      getActivePlan: async () => null, claimDue: async () => { order.push('claim'); return o.due ?? []; },
      skipStale: async (_n: Date, _m: number, onClosed?: (ids: string[]) => void) => { if (o.staleIds) onClosed?.(o.staleIds); return o.staleIds?.length ?? 0; },
      sweepStuck: async () => [], consecutiveFailures: async () => 0,
    },
    runner: {
      runPlanner: async (c: any, opts?: any) => { planned.push({ ch: c.channelKey, extra: opts?.extra }); return {} as any; },
      runExecutor: async (slot: any) => { order.push(`exec:${slot.id}`); return {} as any; },
      runReviewer: async () => ({}) as any,
    },
    enabled: () => true, notify: async () => {}, log: (m) => logs.push(m),
    seriesPauses: { check: async () => { order.push('check'); }, plainPaused: async () => new Set(['@dead']) },
    ...(o.slo ? { slo: o.slo } : {}),
    ...(o.triesFloor ? { triesFloor: o.triesFloor } : {}),
  });
  return { s, order, planned, logs };
}

test('T2 baseline: without the controller (or SLO_CONTROLLER=off) the plainPaused gate of 060 stops planning the paused channel', async () => {
  const a = setup();
  await a.s.tick(NOW);
  assert.deepEqual(a.planned.map((p) => p.ch), ['@alive']);
  const b = setup({ slo: { enabled: () => false, tick: async () => { b.order.push('slo'); }, onSlotClosed: () => {} } });
  await b.s.tick(NOW);
  assert.deepEqual(b.planned.map((p) => p.ch), ['@alive'], 'off = today\'s path');
  assert.ok(!b.order.includes('slo'), 'an off controller is not ticked');
});

test('T2/T4: with the controller on, a channel whose plain slots were skipped keeps planning (no plainPaused gate)', async () => {
  const f = setup({ slo: { enabled: () => true, tick: async () => { f.order.push('slo'); }, onSlotClosed: () => {} } });
  await f.s.tick(NOW);
  assert.deepEqual(f.planned.map((p) => p.ch).sort(), ['@alive', '@dead']);
});

test('T8: the controller ticks after the breaker check and before claiming, with the cards and the paused refs', async () => {
  let seen: any;
  const f = setup({ slo: { enabled: () => true, tick: async (cards, now, paused) => { f.order.push('slo'); seen = { n: cards.length, now, paused: [...paused] }; }, onSlotClosed: () => {} } });
  await f.s.tick(NOW);
  assert.deepEqual(f.order, ['check', 'slo', 'claim']);
  assert.deepEqual(seen, { n: 2, now: NOW, paused: [] });
});

test('T8: a failing controller is logged and the tick goes on to claim', async () => {
  const f = setup({ slo: { enabled: () => true, tick: async () => { throw new Error('db down'); }, onSlotClosed: () => {} } });
  await f.s.tick(NOW);
  assert.ok(f.order.includes('claim'));
  assert.ok(f.logs.some((l) => /SLO controller failed/.test(l)));
});

test('T5: every executed slot and every stale skip is reported to the controller (fire-and-forget; a throwing hook is only logged)', async () => {
  const closed: string[] = [];
  const f = setup({
    slo: { enabled: () => true, tick: async () => {}, onSlotClosed: (id) => { closed.push(id); if (id === 'bad') throw new Error('x'); } },
    due: [{ id: 'run1', channelKey: '@alive' }, { id: 'bad', channelKey: '@alive' }], staleIds: ['stale1'],
  });
  await f.s.tick(NOW);
  assert.deepEqual(closed.sort(), ['bad', 'run1', 'stale1']);
  assert.ok(f.logs.some((l) => /close event of bad failed/.test(l)));
  // Off: not reported.
  const closed2: string[] = [];
  const g = setup({ slo: { enabled: () => false, tick: async () => {}, onSlotClosed: (id) => { closed2.push(id); } }, due: [{ id: 'r', channelKey: '@alive' }], staleIds: ['s'] });
  await g.s.tick(NOW);
  assert.deepEqual(closed2, []);
});

test('FR-005: resetPlannerTries lets a channel that used its 3 tries plan again, and runPlannerNow passes the extra context', async () => {
  const f = setup();
  const t = (min: number) => new Date(NOW.getTime() + min * 60_000);
  await f.s.tick(t(0)); await f.s.tick(t(30)); await f.s.tick(t(60)); await f.s.tick(t(90));
  assert.equal(f.planned.filter((p) => p.ch === '@alive').length, 3, 'capped at PLANNER_MAX_TRIES');
  f.s.resetPlannerTries('@alive', t(95));
  await f.s.tick(t(130));
  assert.equal(f.planned.filter((p) => p.ch === '@alive').length, 4, 'planning again after the reset');
  await f.s.runPlannerNow(mk('@alive') as any, 'dark since Monday');
  assert.deepEqual(f.planned.at(-1), { ch: '@alive', extra: 'dark since Monday' });
  await f.s.runPlannerNow(mk('@alive') as any);
  assert.equal(f.planned.at(-1)!.extra, undefined);
});

test('FR-005: after a restart the persisted floor keeps the cleared tries cleared (only runs after it count)', async () => {
  const sinces: Date[] = [];
  const pool = { query: async (sql: string, p: any[]) => { if (/FROM editor_runs/.test(sql) && /role = 'planner'/.test(sql)) sinces.push(p[3]); return { rows: [] }; } };
  const floor = new Date('2026-11-06T08:30:00Z');
  const f = setup({ pool, triesFloor: async () => floor });
  await f.s.tick(NOW);
  assert.ok(sinces.length > 0);
  assert.equal(sinces[0].toISOString(), floor.toISOString(), 'the count starts at the recovery run, not at the plan hour');
});
