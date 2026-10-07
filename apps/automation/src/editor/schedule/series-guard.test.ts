import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refDataset, seriesNote, seriesSourceMismatch, sourceHints } from './series-guard';
import { seriesSourceLabel } from '../network/series';
import { blackoutWindows, daysLabel, effectivePerDay, frequencyOn, ruleOn, ruleProblems, type ScheduleRule } from './schedule-rules';

const req = (source: any) => ({ name: 'Рецепт дня', source, sourceMode: 'required' as const });

test('series_source_mismatch: library needs the same dataset (data:// or legacy library://)', () => {
  const s = req({ kind: 'library', table: 'recipes' });
  assert.equal(seriesSourceMismatch(s, { libraryRef: 'data://recipes/42' }), null);
  assert.equal(seriesSourceMismatch(s, { libraryRef: 'library://recipes/abc' }), null);
  assert.match(seriesSourceMismatch(s, { libraryRef: 'data://quotes/7' })!, /library:recipes.*quotes/);
  assert.match(seriesSourceMismatch(s, { sourceUrl: 'https://example.com/a' })!, /немає library_ref/);
  // suggested sources never block
  assert.equal(seriesSourceMismatch({ ...s, sourceMode: 'suggested' }, { libraryRef: 'data://quotes/7' }), null);
  assert.equal(refDataset('data://on_this_day/5'), 'on_this_day');
});

test('series_source_mismatch: feed site, api site, network highlights', () => {
  const feeds = [{ id: 'nyt', ref: 'https://www.nytimes.com/rss/food.xml' }];
  assert.equal(seriesSourceMismatch(req({ kind: 'feed', ref: 'nyt' }), { sourceUrl: 'https://cooking.nytimes.com/r/1' }, feeds), null);
  assert.match(seriesSourceMismatch(req({ kind: 'feed', ref: 'nyt' }), { sourceUrl: 'https://bbc.co.uk/food/1' }, feeds)!, /bbc\.co\.uk/);
  assert.match(seriesSourceMismatch(req({ kind: 'feed', ref: 'nyt' }), {}, feeds)!, /немає source\.url/);
  assert.equal(seriesSourceMismatch(req({ kind: 'api', source: 'nasa_apod', params: {} }), { sourceUrl: 'https://apod.nasa.gov/apod/ap261007.html' }), null);
  assert.match(seriesSourceMismatch(req({ kind: 'api', source: 'nasa_apod', params: {} }), { sourceUrl: 'https://space.com/x' })!, /api:nasa_apod/);
  assert.equal(seriesSourceMismatch(req({ kind: 'api', source: 'spaceflight_news', params: {} }), { sourceUrl: 'https://space.com/x' }), null);
  assert.equal(seriesSourceMismatch(req({ kind: 'network_highlights', scope: 'network' }), { sourceUrl: 'https://t.me/food/12' }), null);
  assert.ok(seriesSourceMismatch(req({ kind: 'network_highlights', scope: 'network' }), { sourceUrl: 'https://x.com/1' }));
  assert.equal(seriesSourceMismatch(req({ kind: 'free' }), {}), null);
});

test('executor note: required vs suggested, pins; source hints', () => {
  const base = { name: 'Рецепт дня', brief: 'Рецепт щовечора', format: 'photo', locked: true };
  assert.match(seriesNote({ ...base, source: { kind: 'library', table: 'recipes' }, sourceMode: 'required' }, seriesSourceLabel), /обовʼязкове: library:recipes.*series_source_mismatch/s);
  assert.match(seriesNote({ ...base, source: { kind: 'library', table: 'recipes' }, sourceMode: 'suggested' }, seriesSourceLabel), /необовʼязкове.*поясни чому/s);
  assert.match(seriesNote({ ...base, source: null, sourceMode: 'suggested', pin: true }, seriesSourceLabel), /закріплений пост власника/);
  assert.deepEqual(sourceHints({ kind: 'library', table: 'recipes', category: 'soups' }), ['library:recipes/soups']);
  assert.deepEqual(sourceHints({ kind: 'api', source: 'nasa_apod', params: {} }), ['api:nasa_apod']);
  assert.deepEqual(sourceHints(null), []);
});

const rule = (o: Partial<ScheduleRule>): ScheduleRule => ({
  id: 'r', agentId: 'a', resourceRef: 'telegram:@x', kind: 'blackout', days: null, atLocal: '22:00', untilLocal: '06:00', windowMin: 20,
  format: null, seriesName: null, brief: null, source: null, perDayMin: null, perDayMax: null, validFrom: null, validUntil: null,
  active: true, createdBy: 'owner', note: null, createdAt: new Date(0), updatedAt: new Date(0), ...o,
});

test('rule dates, wrapping blackout windows, the newest frequency rule, per-day minus pins', () => {
  assert.equal(ruleOn(rule({ days: [1, 2, 3, 4, 5] }), '2026-10-10'), false); // Saturday
  assert.equal(ruleOn(rule({ validFrom: '2026-10-08' }), '2026-10-07'), false);
  assert.equal(ruleOn(rule({ active: false }), '2026-10-07'), false);
  const w = blackoutWindows([rule({})], 'telegram:@x', '2026-10-07', 'Europe/Kyiv');
  assert.deepEqual(w.map((x) => [x.start.toISOString(), x.end.toISOString()]), [
    ['2026-10-06T19:00:00.000Z', '2026-10-07T03:00:00.000Z'], // Tue 22:00 → Wed 06:00 (Kyiv)
    ['2026-10-07T19:00:00.000Z', '2026-10-08T03:00:00.000Z'], // Wed 22:00 → Thu 06:00
  ]);
  const older = rule({ kind: 'frequency', perDayMin: 1, perDayMax: 1, updatedAt: new Date('2026-10-01T00:00:00Z') });
  const newer = rule({ id: 'n', kind: 'frequency', perDayMin: 3, perDayMax: 5, updatedAt: new Date('2026-10-02T00:00:00Z') });
  assert.equal(frequencyOn([older, newer], 'telegram:@x', '2026-10-07')?.max, 5);
  assert.deepEqual(effectivePerDay({ min: 2, max: 4 }, null, 1), { min: 1, max: 3 });
  assert.deepEqual(effectivePerDay({ min: 2, max: 4 }, { min: null, max: 1 }, 0), { min: 1, max: 1 });
  assert.equal(daysLabel([1, 2, 3, 4, 5]), 'weekdays');
  assert.equal(daysLabel([4, 1]), 'Mon, Thu');
});

test('rule problems are English and warn about quiet hours', () => {
  assert.deepEqual(ruleProblems({ resource_ref: 'telegram:@x', kind: 'pin', at_local: '23:30', format: 'photo', brief: 'Нічний пост власника' }, { quiet: { start: 23, end: 8 } }), { errors: [], warnings: ['quiet_hours'] });
  const bad = ruleProblems({ resource_ref: 'telegram:@x', kind: 'frequency', per_day_min: 3, per_day_max: 1 }, null);
  assert.deepEqual(bad.errors, ['per_day_min must not exceed per_day_max']);
  assert.ok(ruleProblems({ resource_ref: 'telegram:@x', kind: 'blackout', at_local: '10:00' }, null).errors[0].includes('until_local'));
  assert.ok(ruleProblems({ resource_ref: 'telegram:@x', kind: 'pin', at_local: '10:00' }, null).errors.length === 2);
});
