// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 024 FR-011 acceptance: the Plan timeline is correct with the browser in
// America/New_York — every position and label comes from the network (anchor)
// zone or the resource zone through Intl, never from the browser's getHours().
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorZone, axisHours, axisLabel, connectors, laneZone, packRows, pillTimes, slotMinutes } from './plan-timeline';
import { dayIn, dual, formatIn, isValidZone, minutesFromDayStart, zoneLabel, zonedToUtc } from './zoned-time';

const RES = [
  { ref: 'telegram:@space', timezone: 'Europe/Kyiv' },
  { ref: 'instagram:ig1', timezone: 'America/New_York' },
  { ref: 'threads:th1', timezone: null },
];

test('the browser really is in New York for this file', () => {
  assert.equal(new Date('2026-10-08T06:00:00Z').getHours(), 2, 'getHours() would put a 09:00 Kyiv slot at 02:00');
});

test('axis in the anchor zone: a Kyiv plan day with a New York lane', () => {
  const tz = anchorZone('@space', RES);
  assert.equal(tz, 'Europe/Kyiv');
  assert.equal(laneZone('instagram:ig1', RES, tz), 'America/New_York');
  assert.equal(laneZone('threads:th1', RES, tz), 'Europe/Kyiv', 'no zone → the anchor zone');
  const day = '2026-10-08';
  // 06:00Z = 09:00 Kyiv (UTC+3); 13:00Z = 16:00 Kyiv = 09:00 New York (UTC-4).
  assert.equal(slotMinutes('2026-10-08T06:00:00Z', day, tz), 9 * 60);
  assert.equal(slotMinutes('2026-10-08T13:00:00Z', day, tz), 16 * 60);
  // A New York evening slot is past midnight in Kyiv: it stays on this plan day's axis, after 24:00.
  assert.equal(slotMinutes('2026-10-09T00:30:00Z', day, tz), 27 * 60 + 30);
  assert.deepEqual(axisHours([9 * 60, 16 * 60]), { start: 8, end: 18 });
  assert.deepEqual(axisHours([9 * 60, 27 * 60 + 30]), { start: 8, end: 29 });
  assert.equal(axisLabel(27), '03');
  assert.equal(dayIn(new Date('2026-10-08T22:30:00Z'), tz), '2026-10-09', 'the plan day is the anchor\'s, not the browser\'s');
  assert.equal(dayIn(new Date('2026-10-08T22:30:00Z'), 'America/New_York'), '2026-10-08');
});

test('pill labels: resource time plus Kyiv when they differ', () => {
  assert.deepEqual(pillTimes('2026-10-08T13:00:00Z', 'America/New_York'), { local: '09:00', kyiv: '16:00' });
  assert.deepEqual(pillTimes('2026-10-08T13:00:00Z', 'Europe/Kyiv'), { local: '16:00', kyiv: null });
  assert.equal(dual('2026-10-08T13:00:00Z', 'America/New_York'), '09:00 America/New_York · 16:00 Kyiv');
  assert.equal(dual('2026-10-08T13:00:00Z', 'Europe/Kyiv'), '16:00');
  assert.equal(dual('2026-10-08T13:00:00Z', null), '16:00', 'no zone = Kyiv');
  assert.equal(zoneLabel('Europe/Kyiv'), 'Kyiv');
});

test('DST weeks: Kyiv and New York switch on different weekends', () => {
  // 28 Oct 2026: Kyiv is back on UTC+2 (25 Oct), New York still UTC-4 (until 1 Nov) → 6 h apart.
  assert.equal(dual('2026-10-28T13:00:00Z', 'America/New_York'), '09:00 America/New_York · 15:00 Kyiv');
  // 4 Nov 2026: both on winter time → 7 h apart.
  assert.equal(dual('2026-11-04T14:00:00Z', 'America/New_York'), '09:00 America/New_York · 16:00 Kyiv');
  // A NY 09:00 slot is 13:00 or 14:00 UTC depending on the week.
  assert.equal(zonedToUtc('2026-10-28', 9, 0, 'America/New_York').toISOString(), '2026-10-28T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-11-04', 9, 0, 'America/New_York').toISOString(), '2026-11-04T14:00:00.000Z');
  // The Kyiv plan day of 25 Oct has 25 hours (03:00–04:00 repeats): 23:00 local is 24 real hours after midnight.
  assert.equal(minutesFromDayStart('2026-10-25T21:00:00Z', '2026-10-25', 'Europe/Kyiv'), 24 * 60);
  // Spring gap (NY 8 Mar 2026, 02:30 does not exist) moves forward; autumn ambiguity takes the earlier instant.
  assert.equal(formatIn(zonedToUtc('2026-03-08', 2, 30, 'America/New_York'), 'America/New_York'), '03:30');
  assert.equal(zonedToUtc('2026-11-01', 1, 30, 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
});

test('connectors pair a derived slot with its source; packing keeps pills apart', () => {
  const slots = [
    { id: 'a', derivedFrom: null }, { id: 'b', derivedFrom: 'a' }, { id: 'c', derivedFrom: 'gone' }, { id: 'd', derivedFrom: 'a' },
  ];
  assert.deepEqual(connectors(slots).map((c) => `${c.from.id}→${c.to.id}`), ['a→b', 'a→d']);
  assert.deepEqual(packRows([0, 100, 300, 120], 176), { rows: [0, 1, 0, 2], count: 3 });
});

test('zones are validated through Intl', () => {
  assert.equal(isValidZone('America/New_York'), true);
  assert.equal(isValidZone('Mars/Olympus'), false);
  assert.equal(isValidZone(''), false);
});
