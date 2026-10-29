// Spec 073 T5 (FR-006, A26): Start plans today and tomorrow, each once; a real tomorrow plan is left alone; a throwing today
// still plans tomorrow; "tomorrow" is the card zone's next calendar date, also across a DST change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTodayAndTomorrow } from './plan-ahead';
import { makeCard } from '../post/testing/fixtures';
import { RESERVED_ONLY_RATIONALE, REPURPOSE_RATIONALE } from '../repo/editor-plans.repository';

function setup(o: { plans?: Record<string, { id: string; rationale: string | null }>; todayThrows?: boolean; tomorrowThrows?: boolean; readThrows?: boolean; tz?: string; now?: Date } = {}) {
  const planned: Array<string | undefined> = [];
  const reads: string[] = [];
  const logs: string[] = [];
  const card = makeCard({ channelKey: '@chan', timezone: o.tz ?? 'Europe/Kyiv' });
  const deps = {
    runner: {
      runPlanner: async (_c: any, opts: { planDate?: string } = {}) => {
        planned.push(opts.planDate);
        if (!opts.planDate && o.todayThrows) throw new Error('planner exploded');
        if (opts.planDate && o.tomorrowThrows) throw new Error('tomorrow exploded');
        return {} as any;
      },
    },
    plans: {
      getActivePlan: async (_k: string, date: string) => {
        reads.push(date);
        if (o.readThrows) throw new Error('db down');
        return o.plans?.[date] ?? null;
      },
    },
    now: () => o.now ?? new Date('2026-10-29T10:00:00Z'),
    log: (m: string) => logs.push(m),
  };
  return { deps, card, planned, reads, logs };
}

test('plans today once, then tomorrow once (the card zone\'s next date)', async () => {
  const s = setup();
  await planTodayAndTomorrow(s.deps, s.card);
  assert.deepEqual(s.planned, [undefined, '2026-10-30']);
  assert.deepEqual(s.reads, ['2026-10-30'], 'only tomorrow is looked up; today is the scheduler\'s usual case');
});

test('a tomorrow plan that exists and is real is left alone; a placeholder (reserved only, repurposed) is planned over', async () => {
  const real = setup({ plans: { '2026-10-30': { id: 'p', rationale: 'a real plan' } } });
  await planTodayAndTomorrow(real.deps, real.card);
  assert.deepEqual(real.planned, [undefined]);

  for (const rationale of [RESERVED_ONLY_RATIONALE, REPURPOSE_RATIONALE, null]) {
    const s = setup({ plans: { '2026-10-30': { id: 'p', rationale } } });
    await planTodayAndTomorrow(s.deps, s.card);
    // A null rationale is a plan without a recorded rationale: it counts as real (as in maybePlanAhead).
    assert.deepEqual(s.planned, rationale === null ? [undefined] : [undefined, '2026-10-30'], String(rationale));
  }
});

test('a throwing today run is logged and tomorrow is still planned; a throwing tomorrow run or plan read is logged, nothing escapes', async () => {
  const a = setup({ todayThrows: true });
  await planTodayAndTomorrow(a.deps, a.card);
  assert.deepEqual(a.planned, [undefined, '2026-10-30']);
  assert.ok(a.logs.some((l) => /for today failed: planner exploded/.test(l)), a.logs.join('|'));

  const b = setup({ tomorrowThrows: true });
  await planTodayAndTomorrow(b.deps, b.card);
  assert.ok(b.logs.some((l) => /2026-10-30 failed: tomorrow exploded/.test(l)), b.logs.join('|'));

  const c = setup({ readThrows: true });
  await planTodayAndTomorrow(c.deps, c.card);
  assert.deepEqual(c.planned, [undefined], 'an unreadable tomorrow is not planned blindly');
  assert.ok(c.logs.some((l) => /db down/.test(l)));
});

test('tomorrow is a calendar date in the card zone, right across a DST change and near local midnight', async () => {
  // Europe/Kyiv leaves summer time on 2026-10-25 (a 25-hour day): date arithmetic gives the next calendar date, not +24 h.
  const kyiv = setup({ now: new Date('2026-10-24T20:30:00Z') });      // 23:30 on the 24th in Kyiv (UTC+3)
  await planTodayAndTomorrow(kyiv.deps, kyiv.card);
  assert.deepEqual(kyiv.planned, [undefined, '2026-10-25']);
  const after = setup({ now: new Date('2026-10-25T22:30:00Z') });     // 00:30 on the 26th in Kyiv (UTC+2), the day after the 25-hour one
  await planTodayAndTomorrow(after.deps, after.card);
  assert.deepEqual(after.planned, [undefined, '2026-10-27']);

  // A zone far from Kyiv: it is already the next day there while Kyiv's date has not changed.
  const sydney = setup({ tz: 'Australia/Sydney', now: new Date('2026-10-29T20:00:00Z') });  // 07:00 on the 30th in Sydney (UTC+11)
  await planTodayAndTomorrow(sydney.deps, sydney.card);
  assert.deepEqual(sydney.planned, [undefined, '2026-10-31']);

  // A zone whose clocks go back on the day itself (America/New_York, 2026-11-01).
  const ny = setup({ tz: 'America/New_York', now: new Date('2026-11-01T04:30:00Z') });      // 00:30 on 2026-11-01 (EDT); the clocks go back at 02:00
  await planTodayAndTomorrow(ny.deps, ny.card);
  assert.deepEqual(ny.planned, [undefined, '2026-11-02']);
});
