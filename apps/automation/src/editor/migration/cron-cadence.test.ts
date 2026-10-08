import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronToCadence, zoneShiftMinutes } from './cron-cadence';

const WINTER = new Date('2030-01-15T10:00:00Z'); // Kyiv UTC+2
const SUMMER = new Date('2030-07-15T10:00:00Z'); // Kyiv UTC+3
const KYIV = 'Europe/Kyiv';
const base = { cronTz: KYIV, targetTz: KYIV, quiet: { start: 23, end: 8 }, now: WINTER };

test('a fixed minute and an hour list → a daily cadence', () => {
  assert.deepEqual(cronToCadence({ ...base, schedule: '15 8,14,20 * * *' }), { kind: 'series', cadence: 'daily@08:15,14:15,20:15', perDay: 3, dropped: [], warnings: [] });
});

test('the digest retry cron */10 19-20 becomes one time, 19:00', () => {
  const r = cronToCadence({ ...base, schedule: '*/10 19-20 * * *', retryLoop: true });
  assert.equal(r.kind, 'series');
  assert.equal(r.kind === 'series' && r.cadence, 'daily@19:00');
  assert.match(r.kind === 'series' ? r.warnings.join() : '', /collapsed/);
});

test('0 */4: quiet-hour times are dropped, the rest is a series', () => {
  const r = cronToCadence({ ...base, schedule: '0 */4 * * *' });
  assert.equal(r.kind, 'series');
  if (r.kind !== 'series') return;
  assert.equal(r.cadence, 'daily@08:00,12:00,16:00,20:00');
  assert.deepEqual(r.dropped, ['00:00', '04:00']);
});

test('a minute step (*/30) is a frequency hint, not a series', () => {
  const r = cronToCadence({ ...base, schedule: '*/30 * * * *' });
  assert.equal(r.kind, 'frequency');
  assert.equal(r.kind === 'frequency' && r.perDay, 48);
  const news = cronToCadence({ ...base, schedule: '*/30 8-22 * * *' });
  assert.equal(news.kind, 'frequency');
  assert.equal(news.kind === 'frequency' && news.perDay, 30);
});

test('more than 6 times a day is a frequency hint', () => {
  const r = cronToCadence({ ...base, schedule: '0 8-22/2 * * *' });
  assert.equal(r.kind, 'frequency');
  assert.match(r.kind === 'frequency' ? r.reason : '', /8 times a day/);
  assert.equal(cronToCadence({ ...base, schedule: '0,30 8,11,14,17,20 * * *' }).kind, 'frequency');
});

test('day-of-week lists, ranges and names → weekly cadences', () => {
  assert.equal((cronToCadence({ ...base, schedule: '0 9 * * 1,4' }) as any).cadence, 'weekly:mon,thu@09:00');
  assert.equal((cronToCadence({ ...base, schedule: '30 10 * * mon-fri' }) as any).cadence, 'weekly:mon,tue,wed,thu,fri@10:30');
  assert.equal((cronToCadence({ ...base, schedule: '0 12 * * 0,7' }) as any).cadence, 'weekly:sun@12:00');
  assert.equal((cronToCadence({ ...base, schedule: '0 12 * * 0-6' }) as any).cadence, 'daily@12:00');
});

test('scheduler zone → resource zone at today\'s offsets (UTC cron, Kyiv resource)', () => {
  assert.equal(zoneShiftMinutes('UTC', KYIV, WINTER), 120);
  assert.equal(zoneShiftMinutes('UTC', KYIV, SUMMER), 180);
  const w = cronToCadence({ ...base, cronTz: 'UTC', schedule: '0 7 * * *' });
  assert.equal(w.kind === 'series' && w.cadence, 'daily@09:00');
  assert.match(w.kind === 'series' ? w.warnings.join() : '', /converted from UTC to Europe\/Kyiv \(\+120 min/);
  const s = cronToCadence({ ...base, cronTz: 'UTC', now: SUMMER, schedule: '0 7 * * *' });
  assert.equal(s.kind === 'series' && s.cadence, 'daily@10:00');
});

test('a time that crosses midnight moves its weekday too', () => {
  const r = cronToCadence({ ...base, cronTz: 'UTC', quiet: { start: 0, end: 0 }, schedule: '0 23 * * 1' });
  assert.equal(r.kind === 'series' && r.cadence, 'weekly:tue@01:00');
  // Only some times cross midnight → split by hand.
  assert.equal(cronToCadence({ ...base, cronTz: 'UTC', quiet: { start: 0, end: 0 }, schedule: '0 12,23 * * 1' }).kind, 'unmappable');
});

test('unmappable: day of month, month, all times in quiet hours, unreadable', () => {
  assert.match((cronToCadence({ ...base, schedule: '0 9 1 * *' }) as any).reason, /day of month/);
  assert.match((cronToCadence({ ...base, schedule: '0 9 * 1 *' }) as any).reason, /month/);
  assert.match((cronToCadence({ ...base, schedule: '0 2,3 * * *' }) as any).reason, /quiet hours/);
  assert.equal(cronToCadence({ ...base, schedule: 'every day' }).kind, 'unmappable');
  assert.equal(cronToCadence({ ...base, schedule: '0 25 * * *' }).kind, 'unmappable');
});

test('the optional seconds field: a fixed second is fine, a step is not', () => {
  assert.equal((cronToCadence({ ...base, schedule: '0 0 9 * * *' }) as any).cadence, 'daily@09:00');
  assert.equal(cronToCadence({ ...base, schedule: '*/5 0 9 * * *' }).kind, 'unmappable');
});
