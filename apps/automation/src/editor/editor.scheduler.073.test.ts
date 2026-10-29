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

// ── FR-005 (A13, A14, A43): planner tries survive a restart ──────────────────

interface PlannerRow { n: number; failed: number; last_failed_at: Date | null }

/** A fresh scheduler (= a restarted process) over a pool that answers the `plannerRunsOn` SQL with `row`. */
function restarted(o: { row?: PlannerRow; readThrows?: boolean; approval?: boolean; todayHasPlan?: boolean; cardOver?: any } = {}) {
  const planned: Array<{ key: string; planDate?: string }> = [];
  const plannerQueries: any[][] = [];
  const logs: string[] = [];
  const card = { ...makeCard({ planHour: 6, ...(o.cardOver ?? {}) }), createdAt: new Date('2026-01-01') };
  const s = new EditorScheduler({
    pool: {
      query: async (sql: string, params: any[]) => {
        if (/e\.role = 'planner'/.test(sql)) {
          plannerQueries.push(params);
          if (o.readThrows) throw new Error('db down');
          return { rows: [o.row ?? { n: 0, failed: 0, last_failed_at: null }] };
        }
        return { rows: [{}] };
      },
    } as any,
    channels: { listActive: async () => [card] },
    plans: {
      // Today has a real plan when asked to; tomorrow never does.
      getActivePlan: async (_k: string, date: string) => (o.todayHasPlan && date === '2026-10-01' ? { id: 'p', rationale: null } : null),
      claimDue: async () => [], skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0,
    },
    runner: {
      runPlanner: async (c: any, opts: any = {}) => { planned.push({ key: c.channelKey, planDate: opts.planDate }); return {} as any; },
      runExecutor: async () => ({}) as any, runReviewer: async () => ({}) as any,
    },
    ...(o.approval ? { approval: { mode: async () => 'approve' as const, tick: async () => {} } } : {}),
    enabled: () => true, notify: async () => {}, log: (m) => logs.push(m),
  });
  return { s, planned, plannerQueries, logs, card };
}

// 2026-10-01 is a Thursday; Kyiv is UTC+3. Plan hour 6 = 03:00Z.
const at = (hhmmZ: string, day = '2026-10-01') => new Date(`${day}T${hhmmZ}:00Z`);

test('today\'s key: three failed planner runs (06:00, 06:30, 07:00) then a restart at 15:00 — no fourth try', async () => {
  const t = restarted({ row: { n: 3, failed: 3, last_failed_at: at('04:00') } });
  await t.s.tick(at('12:00'));
  assert.deepEqual(t.planned, []);
  // The seed asked for the channel's planner runs of the local day since the plan hour, in the card's zone.
  assert.deepEqual(t.plannerQueries, [['@chan', 'Europe/Kyiv', '2026-10-01', at('03:00')]]);
  await t.s.tick(at('12:01'));
  assert.equal(t.plannerQueries.length, 1, 'only an absent key is seeded: the second tick does not read the runs again');
});

test('today\'s key: two failures then a restart — one more try, no sooner than 30 minutes after the second', async () => {
  const t = restarted({ row: { n: 2, failed: 2, last_failed_at: at('04:00') } });   // the second failure at 07:00 local
  await t.s.tick(at('04:10'));                                                       // 10 minutes after it
  assert.equal(t.planned.length, 0, 'too soon after the last failed try');
  await t.s.tick(at('04:30'));
  assert.deepEqual(t.planned.map((p) => p.key), ['@chan'], 'the third try, 30 minutes after the second');
  await t.s.tick(at('05:01'));
  assert.equal(t.planned.length, 1, 'and no fourth: the seed counted 2, this process counted the third');
});

test('today\'s key: no earlier failures (n = 0) plans at once; runs that made a plan do not count (failed = 0 while n > 0)', async () => {
  const a = restarted();
  await a.s.tick(at('04:00'));
  assert.equal(a.planned.length, 1);
  const b = restarted({ row: { n: 2, failed: 0, last_failed_at: null } });
  await b.s.tick(at('04:00'));
  assert.equal(b.planned.length, 1, 'two earlier runs that made plans (since replaced) are not failed tries');
});

test('a failing read of the planner runs is logged and the tick plans as before; a day with a real plan is not even read', async () => {
  const t = restarted({ readThrows: true });
  await t.s.tick(at('04:00'));
  assert.equal(t.planned.length, 1);
  assert.ok(t.logs.some((l) => /planner runs of @chan could not be read: db down/.test(l)), t.logs.join('|'));
  await t.s.tick(at('04:31'));
  assert.equal(t.plannerQueries.length, 1, 'the try this process made put the key in the Map: no second read');
  assert.equal(t.planned.length, 2, 'and the retry spacing works from this process\'s own count');

  const done = restarted({ todayHasPlan: true });
  await done.s.tick(at('04:00'));
  assert.deepEqual([done.planned, done.plannerQueries], [[], []]);
});

test('the ahead key (approval mode, from 20:00): seeded from the batch hour today; three failed ahead tries stop a fourth after a restart', async () => {
  // 21:30 Kyiv = 18:30Z; the batch hour is 20:00 local = 17:00Z. Today (10-01) already has its plan, so only the ahead key is in play.
  const blocked = restarted({ approval: true, todayHasPlan: true, row: { n: 3, failed: 3, last_failed_at: at('17:30') } });
  await blocked.s.tick(at('18:30'));
  assert.deepEqual(blocked.planned, []);
  assert.deepEqual(blocked.plannerQueries, [['@chan', 'Europe/Kyiv', '2026-10-01', at('17:00')]], 'day = today, since = 20:00 local today');

  const retry = restarted({ approval: true, todayHasPlan: true, row: { n: 1, failed: 1, last_failed_at: at('18:10') } });
  await retry.s.tick(at('18:30'));                                                   // 20 minutes after the failed one
  assert.deepEqual(retry.planned, []);
  await retry.s.tick(at('18:40'));                                                   // 30 minutes after
  assert.deepEqual(retry.planned, [{ key: '@chan', planDate: '2026-10-02' }], 'one more try for tomorrow\'s batch');
});
