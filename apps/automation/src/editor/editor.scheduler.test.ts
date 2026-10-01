import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorScheduler, PLANNER_RETRY_MS } from './editor.scheduler';
import { makeCard } from './post/testing/fixtures';

function setup(opts: { activePlan?: boolean; due?: any[]; cards?: any[]; reviewedRecently?: boolean; failures?: number; enabled?: boolean } = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  const cards = opts.cards ?? [{ ...makeCard({ planHour: 6 }), createdAt: new Date('2026-01-01') }];
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: opts.reviewedRecently ? [{}] : [] }) } as any,
    channels: { listActive: async () => cards },
    plans: {
      getActivePlan: async () => (opts.activePlan ? { id: 'p', rationale: null } : null),
      claimDue: async () => opts.due ?? [],
      skipStale: async () => { calls.push('skipStale'); return 0; },
      sweepStuck: async () => { calls.push('sweep'); return []; },
      consecutiveFailures: async () => opts.failures ?? 0,
    },
    runner: {
      runPlanner: async (c: any) => { calls.push(`plan:${c.channelKey}`); return {} as any; },
      runExecutor: async (slot: any) => { calls.push(`exec:${slot.id}`); return {} as any; },
      runReviewer: async (c: any) => { calls.push(`review:${c.channelKey}`); return {} as any; },
    },
    enabled: () => opts.enabled ?? true,
    notify: async (t) => { notes.push(t); },
  });
  return { s, calls, notes };
}

// 2026-10-01 is a Thursday. 07:00 Kyiv = 04:00Z.
const THU_0700 = new Date('2026-10-01T04:00:00Z');
const THU_0500 = new Date('2026-10-01T02:00:00Z');
const MON_0600 = new Date('2026-10-05T03:00:00Z');

test('housekeeping runs first; planner runs after plan_hour when no active plan', async () => {
  const { s, calls } = setup();
  await s.tick(THU_0700);
  assert.deepEqual(calls.slice(0, 3), ['skipStale', 'sweep', 'plan:@chan']);
});

test('no planning before plan_hour or when a plan exists', async () => {
  const a = setup(); await a.s.tick(THU_0500);
  assert.ok(!a.calls.some((c) => c.startsWith('plan:')));
  const b = setup({ activePlan: true }); await b.s.tick(THU_0700);
  assert.ok(!b.calls.some((c) => c.startsWith('plan:')));
});

test('planner retries are throttled and capped', async () => {
  const { s, calls } = setup();
  await s.tick(THU_0700);
  await s.tick(new Date(THU_0700.getTime() + 60_000));                 // too soon
  await s.tick(new Date(THU_0700.getTime() + PLANNER_RETRY_MS));       // 2nd
  await s.tick(new Date(THU_0700.getTime() + 2 * PLANNER_RETRY_MS));   // 3rd
  await s.tick(new Date(THU_0700.getTime() + 3 * PLANNER_RETRY_MS));   // capped
  assert.equal(calls.filter((c) => c.startsWith('plan:')).length, 3);
});

test('executes claimed slots only for active channels; alerts on 3 failures once', async () => {
  const { s, calls, notes } = setup({ activePlan: true, failures: 3, due: [{ id: 'a', channelKey: '@chan' }, { id: 'b', channelKey: '@chan' }, { id: 'x', channelKey: '@gone' }] });
  await s.tick(THU_0700);
  assert.deepEqual(calls.filter((c) => c.startsWith('exec:')).sort(), ['exec:a', 'exec:b']);
  assert.equal(notes.length, 1);
});

test('weekly review on Monday, not twice, not for new cards', async () => {
  const a = setup({ activePlan: true }); await a.s.tick(MON_0600);
  assert.ok(a.calls.includes('review:@chan'));
  const b = setup({ activePlan: true, reviewedRecently: true }); await b.s.tick(MON_0600);
  assert.ok(!b.calls.includes('review:@chan'));
  const c = setup({ activePlan: true, cards: [{ ...makeCard(), createdAt: new Date('2026-10-03') }] }); await c.s.tick(MON_0600);
  assert.ok(!c.calls.includes('review:@chan'));
  const d = setup({ activePlan: true }); await d.s.tick(THU_0700);
  assert.ok(!d.calls.includes('review:@chan'));
});

test('cronTick is a no-op when disabled', async () => {
  const { s, calls } = setup({ enabled: false });
  await s.cronTick();
  assert.equal(calls.length, 0);
});
