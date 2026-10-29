// Spec 073 T4 (FR-004): the scheduler closes a claimed slot whose channel is not active with `mode_changed` instead of
// leaving it `running` for `sweepStuck` to call «stuck in running (crash?)».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorScheduler } from './editor.scheduler';
import { makeCard } from './post/testing/fixtures';
import { isNotAMiss } from './silent/skip-reasons';

const THU_0700 = new Date('2026-10-01T04:00:00Z');

function setup(due: any[]) {
  const calls: string[] = [];
  const updates: Array<{ id: string; patch: any }> = [];
  const cards = [{ ...makeCard({ planHour: 6 }), createdAt: new Date('2026-01-01') }];
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [{}] }) } as any,
    channels: { listActive: async () => cards },
    plans: {
      getActivePlan: async () => ({ id: 'p', rationale: null }),
      claimDue: async () => due,
      skipStale: async () => 0,
      sweepStuck: async () => [],
      consecutiveFailures: async () => 0,
      updateSlot: async (id: string, patch: any) => { updates.push({ id, patch }); },
    },
    runner: {
      runPlanner: async () => ({}) as any,
      runExecutor: async (slot: any) => { calls.push(`exec:${slot.id}`); return {} as any; },
      runReviewer: async () => ({}) as any,
    },
    enabled: () => true,
    notify: async () => {},
  });
  return { s, calls, updates };
}

test('a claimed slot of a channel that is not active is skipped as mode_changed (a NOT_A_MISS reason), never left running', async () => {
  const { s, calls, updates } = setup([{ id: 'a', channelKey: '@chan' }, { id: 'off', channelKey: '@was-off' }]);
  await s.tick(THU_0700);
  assert.deepEqual(calls, ['exec:a'], 'the active channel\'s slot runs');
  assert.deepEqual(updates, [{ id: 'off', patch: { status: 'skipped', error: 'mode_changed' } }]);
  assert.equal(isNotAMiss('mode_changed'), true);
});

test('a failing updateSlot while skipping a mode_changed slot is logged, not thrown', async () => {
  const logs: string[] = [];
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [{}] }) } as any,
    channels: { listActive: async () => [{ ...makeCard({ planHour: 6 }), createdAt: new Date('2026-01-01') }] },
    plans: {
      getActivePlan: async () => ({ id: 'p', rationale: null }),
      claimDue: async () => [{ id: 'off', channelKey: '@was-off' }] as any,
      skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0,
      updateSlot: async () => { throw new Error('db down'); },
    },
    runner: { runPlanner: async () => ({}) as any, runExecutor: async () => ({}) as any, runReviewer: async () => ({}) as any },
    enabled: () => true, notify: async () => {}, log: (m) => logs.push(m),
  });
  await s.tick(THU_0700);
  assert.ok(logs.some((l) => /skipping slot off failed/.test(l)), logs.join('|'));
});
