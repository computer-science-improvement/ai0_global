import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuietHour, localDate, localHour, localWeekday, zonedToUtc } from './time';

test('zonedToUtc handles Kyiv summer (+3) and winter (+2)', () => {
  assert.equal(zonedToUtc('2026-07-01', '09:00', 'Europe/Kyiv').toISOString(), '2026-07-01T06:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', '09:00', 'Europe/Kyiv').toISOString(), '2026-12-01T07:00:00.000Z');
});

test('local date/hour/weekday across midnight', () => {
  const d = new Date('2026-10-01T22:30:00Z'); // 01:30 on Oct 2 in Kyiv (UTC+3)
  assert.equal(localDate(d, 'Europe/Kyiv'), '2026-10-02');
  assert.equal(localHour(d, 'Europe/Kyiv'), 1);
  assert.equal(localWeekday(d, 'Europe/Kyiv'), 5); // Friday
});

test('quiet hours wrap midnight', () => {
  assert.equal(isQuietHour(23, 23, 8), true);
  assert.equal(isQuietHour(3, 23, 8), true);
  assert.equal(isQuietHour(8, 23, 8), false);
  assert.equal(isQuietHour(14, 13, 15), true);
  assert.equal(isQuietHour(10, 0, 0), false);
});
