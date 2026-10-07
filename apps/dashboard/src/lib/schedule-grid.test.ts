// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCadence, cadenceLabel, cellEntries, daysLabel, parseCadence, ruleLabel, sourceLabel, tzShort, warningsText } from './schedule-grid';

const TG = 'telegram:@food';

test('cells: series and pins take their slot\'s status; other slots stay on their own; frequency first', () => {
  const s: any = {
    items: [
      { kind: 'series', resourceRef: TG, date: '2026-10-07', time: '19:00', at: '', name: 'Recipe', format: 'photo', locked: true, origin: 'owner' },
      { kind: 'pin', ruleId: 'p1', resourceRef: TG, date: '2026-10-07', time: '12:00', at: '', format: 'text', seriesName: null, brief: 'Owner tip' },
      { kind: 'blackout', ruleId: 'b1', resourceRef: TG, date: '2026-10-07', time: '13:00', until: '15:00' },
      { kind: 'frequency', ruleId: 'f1', resourceRef: TG, date: '2026-10-07', min: 1, max: 2 },
      { kind: 'series', resourceRef: TG, date: '2026-10-08', time: '19:00', at: '', name: 'Recipe', format: 'photo', locked: true, origin: 'owner' },
    ],
    slots: [
      { id: 's1', resourceRef: TG, date: '2026-10-07', time: '19:45', kind: 'content', status: 'planned', format: 'photo', topic: 'Borscht', seriesName: 'Recipe', scheduleRuleId: null, promo: false },
      { id: 's2', resourceRef: TG, date: '2026-10-07', time: '12:00', kind: 'content', status: 'shadowed', format: 'text', topic: 'Owner tip', seriesName: null, scheduleRuleId: 'p1', promo: false },
      { id: 's3', resourceRef: TG, date: '2026-10-07', time: '09:00', kind: 'content', status: 'published', format: 'photo', topic: 'Breakfast', seriesName: null, scheduleRuleId: null, promo: false },
      { id: 's4', resourceRef: TG, date: '2026-10-07', time: '17:00', kind: 'reserved', status: 'planned', format: 'photo', topic: 'Ad', seriesName: null, scheduleRuleId: null, promo: false },
    ],
  };
  const e = cellEntries(s, TG, '2026-10-07');
  assert.deepEqual(e.map((x) => [x.kind, x.time, x.status ?? null]), [
    ['frequency', '', null], ['slot', '09:00', 'published'], ['pin', '12:00', 'shadowed'], ['blackout', '13:00', null],
    ['reserved', '17:00', 'planned'], ['series', '19:45', 'planned'],
  ]);
  assert.equal(cellEntries(s, TG, '2026-10-08')[0].status, undefined);
  assert.deepEqual(cellEntries(s, 'instagram:x', '2026-10-07'), []);
});

test('cadence: build from days and times, parse back, label in English', () => {
  assert.deepEqual(buildCadence(null, '19:00'), { cadence: 'daily@19:00' });
  assert.deepEqual(buildCadence([0, 1, 2, 3, 4, 5, 6], '21:30, 9:15'), { cadence: 'daily@09:15,21:30' });
  assert.deepEqual(buildCadence([4, 1], '20:30'), { cadence: 'weekly:mon,thu@20:30' });
  assert.match((buildCadence([1], '25:00') as any).error, /Not a time/);
  assert.match((buildCadence([], '10:00') as any).error, /at least one day/);
  assert.match((buildCadence(null, '01:00,02:00,03:00,04:00,05:00,06:00,07:00') as any).error, /At most 6/);
  assert.deepEqual(parseCadence('weekly:mon,tue,wed,thu,fri@20:30'), { days: [1, 2, 3, 4, 5], times: ['20:30'] });
  assert.equal(cadenceLabel('weekly:mon,tue,wed,thu,fri@20:30'), 'weekdays 20:30');
  assert.equal(cadenceLabel('weekly:sun,sat@10:00,18:00'), 'weekends 10:00, 18:00');
  assert.equal(daysLabel([0, 3]), 'Wed, Sun');
});

test('labels: rules, sources, warnings, zone', () => {
  assert.equal(ruleLabel({ kind: 'pin', days: [1, 2, 3, 4, 5], at_local: '19:00', until_local: null, format: 'photo', series_name: null, per_day_min: null, per_day_max: null }), 'Pin 19:00 weekdays · photo');
  assert.equal(ruleLabel({ kind: 'blackout', days: null, at_local: '22:00', until_local: '06:00', format: null, series_name: null, per_day_min: null, per_day_max: null }), 'No posts 22:00–06:00 every day');
  assert.equal(ruleLabel({ kind: 'frequency', days: [0, 6], at_local: null, until_local: null, format: null, series_name: null, per_day_min: 1, per_day_max: 2 }), '1–2 posts a day weekends');
  assert.equal(sourceLabel({ kind: 'library', table: 'recipes' }), 'library: recipes');
  assert.equal(sourceLabel(null), 'no source');
  assert.equal(warningsText([]), null);
  assert.equal(warningsText(['quiet_hours', 'conflicts_with_reserved']), 'Saved, but it falls in the quiet hours; it is close to a reserved (ad) slot — both stay.');
  assert.equal(tzShort('Europe/Kyiv', new Date('2026-07-01T12:00:00Z')), 'GMT+3');
  assert.equal(tzShort('Not/AZone'), 'Not/AZone');
});
