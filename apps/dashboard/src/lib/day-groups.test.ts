// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 C3: day labels and the per-day grouping of the logs timeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayEyebrow, dayHeading, fmtDayShort, groupByDay, previousDay } from './day-groups';

test('fmtDayShort: weekday, day and month; not a day comes back as given', () => {
  assert.equal(fmtDayShort('2026-10-29'), 'Thu, 29 Oct');
  assert.equal(fmtDayShort('2026-01-01'), 'Thu, 1 Jan');
  assert.equal(fmtDayShort('soon'), 'soon');
});

test('dayEyebrow: "Thu, 29 Oct · Kyiv", null while the day is unknown', () => {
  assert.equal(dayEyebrow('2026-10-29'), 'Thu, 29 Oct · Kyiv');
  assert.equal(dayEyebrow('2026-10-29', 'Europe/Warsaw'), 'Thu, 29 Oct · Europe/Warsaw');
  assert.equal(dayEyebrow(undefined), null);
  assert.equal(dayEyebrow(''), null);
  assert.equal(dayEyebrow('29/10'), null);
});

test('previousDay crosses month and year ends', () => {
  assert.equal(previousDay('2026-10-29'), '2026-10-28');
  assert.equal(previousDay('2026-11-01'), '2026-10-31');
  assert.equal(previousDay('2027-01-01'), '2026-12-31');
  assert.equal(previousDay('2028-03-01'), '2028-02-29');
});

test('dayHeading: Today, Yesterday, then the short date', () => {
  assert.equal(dayHeading('2026-10-29', '2026-10-29'), 'Today');
  assert.equal(dayHeading('2026-10-28', '2026-10-29'), 'Yesterday');
  assert.equal(dayHeading('2026-10-27', '2026-10-29'), 'Tue, 27 Oct');
});

test('groupByDay: keeps the order, splits on the Kyiv midnight, never drops a row', () => {
  const rows = [
    { at: '2026-10-29T20:59:00.000Z', n: 1 },   // 22:59 Kyiv on the 29th (UTC+2 since 25 Oct)
    { at: '2026-10-29T22:30:00.000Z', n: 2 },   // 00:30 Kyiv on the 30th
    { at: '2026-10-29T10:00:00.000Z', n: 3 },
    { at: 'garbage', n: 4 },
  ];
  const g = groupByDay(rows, 'Europe/Kyiv');
  assert.deepEqual(g.map((x) => [x.day, x.items.map((i) => i.n)]), [
    ['2026-10-29', [1]], ['2026-10-30', [2]], ['2026-10-29', [3]], ['—', [4]],
  ]);
  assert.deepEqual(groupByDay([], 'Europe/Kyiv'), []);
});
