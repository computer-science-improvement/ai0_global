import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from './plan-rules';
import { makeCard } from '../post/testing/fixtures';

const card = makeCard({ postsPerDayMin: 2, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, exploreRatio: 0.25 });
const now = new Date('2026-10-01T04:00:00Z'); // 07:00 Kyiv
const slot = (time: string, extra: any = {}) => ({ time, format: 'photo', topic: 'Тема поста про космос', source_hints: [], is_experiment: false, ...extra });

test('valid plan converts local times to UTC', () => {
  const v = validatePlan({ rationale: 'Два пости у найкращі години', slots: [slot('09:00'), slot('19:30')] }, card, '2026-10-01', now);
  assert.equal(v.ok, true);
  assert.equal((v as any).slots[0].scheduledAt.toISOString(), '2026-10-01T06:00:00.000Z');
});

test('count bounds include reserved slots', () => {
  const tooFew = validatePlan({ rationale: 'мало постів сьогодні', slots: [slot('09:00')] }, card, '2026-10-01', now);
  assert.equal(tooFew.ok, false);
  const withReserved = validatePlan({ rationale: 'один + резерв', slots: [slot('09:00')] }, card, '2026-10-01', now, [new Date('2026-10-01T12:00:00Z')]);
  assert.equal(withReserved.ok, true);
});

test('rejects past, quiet hours, order, gap, format, reserved proximity', () => {
  const v = validatePlan({ rationale: 'поганий план для тесту', slots: [
    slot('06:30'),                    // past (07:00 now)
    slot('23:30'),                    // quiet
    slot('10:00', { format: 'video' }), // not increasing + unsupported format
    slot('10:30'),                    // gap < 60
  ] }, card, '2026-10-01', now, [new Date('2026-10-01T07:15:00Z')]);
  assert.equal(v.ok, false);
  const e = (v as any).errors.join('\n');
  assert.match(e, /минув/);
  assert.match(e, /тихі години/);
  assert.match(e, /зростанням/);
  assert.match(e, /не дозволений/);
  assert.match(e, /інтервал/);
  assert.match(e, /резервного/);
});

test('experiment share capped by explore_ratio', () => {
  const v = validatePlan({ rationale: 'забагато експериментів', slots: [slot('09:00', { is_experiment: true }), slot('12:00', { is_experiment: true })] }, card, '2026-10-01', now);
  assert.equal(v.ok, false);
  assert.match((v as any).errors[0], /експериментів/);
});

test('late start lowers the minimum to what still fits', () => {
  const late = new Date('2026-10-01T19:10:00Z'); // 22:10 Kyiv, quiet from 23:00
  const v = validatePlan({ rationale: 'пізній старт, один пост', slots: [slot('22:30')] }, card, '2026-10-01', late);
  assert.equal(v.ok, true, JSON.stringify(v));
  const none = validatePlan({ rationale: 'пізній старт, нічого', slots: [] }, card, '2026-10-01', new Date('2026-10-01T20:30:00Z'));
  assert.equal(none.ok, true, JSON.stringify(none));
});
