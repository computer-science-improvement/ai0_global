import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Playbook, PlaybookSchema, structuralForSilence, structuralForSilenceReasons } from './playbook';

/** Spec 090 FR-004: which pending playbook versions keep waiting for the owner although the owner is silent. */

const pb = (o: Partial<Playbook> = {}): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: 'telegram:@space', role: 'core', formats: { longread: 0.6, photo: 0.4 }, per_day: { min: 1, max: 3 }, best_hours: [10, 19] },
    { resource_ref: 'instagram:ig1', role: 'funnel_to:telegram:@space', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 } },
  ],
  series: [
    { name: 'Топ тижня', cadence: 'weekly:sun@10:00', resource_ref: 'instagram:ig1', format: 'ig_carousel', brief: 'Пʼять найкращих новин тижня' },
    { name: 'Моя серія', cadence: 'weekly:mon@10:00', resource_ref: 'instagram:ig1', format: 'ig_carousel', brief: 'Серія власника', origin: 'owner', locked: true },
  ],
  pillars: [{ name: 'Новини', share: 60 }, { name: 'Факти', share: 40 }],
  rules: ['Без астрології', 'Не більше двох емодзі'],
  ...o,
});

test('a tone-only change is not structural', () => {
  const prev = pb();
  const next = structuredClone(prev);
  next.platforms[0].tone = 'Спокійніше, без вигуків';
  next.platforms[0].best_hours = [9, 20];
  next.series[0].brief = 'Пʼять найцікавіших новин тижня';
  assert.equal(structuralForSilence(prev, next), false);
  assert.deepEqual(structuralForSilenceReasons(prev, next, { createdBy: 'orchestrator' }), []);
});

test('a change to a locked or owner series is structural, and so is deleting it', () => {
  const prev = pb();
  const changed = structuredClone(prev);
  changed.series[1].brief = 'Інший опис';
  assert.equal(structuralForSilence(prev, changed), true);
  const removed = structuredClone(prev);
  removed.series = removed.series.slice(0, 1);
  assert.equal(structuralForSilence(prev, removed), true);
  // locked without owner origin, and owner origin without lock, both count.
  const lockedOnly = pb({ series: [{ ...prev.series[0], locked: true }] });
  const lockedChanged = structuredClone(lockedOnly);
  lockedChanged.series[0].brief = 'Змінений опис';
  assert.equal(structuralForSilence(lockedOnly, lockedChanged), true);
  const ownerOnly = pb({ series: [{ ...prev.series[0], origin: 'owner', locked: false }] });
  const ownerChanged = structuredClone(ownerOnly);
  ownerChanged.series[0].brief = 'Змінений опис';
  assert.equal(structuralForSilence(ownerOnly, ownerChanged), true);
});

test('an agent series change is not structural for silence; the ownership flags alone do not count', () => {
  const prev = pb();
  const next = structuredClone(prev);
  next.series[0].brief = 'Нове формулювання';
  next.series[1].locked = true;
  assert.equal(structuralForSilence(prev, next), false);
});

test('adding or removing a platform section is structural', () => {
  const prev = pb();
  const added = structuredClone(prev);
  added.platforms.push({ resource_ref: 'threads:th1', role: 'discovery', formats: { th_text: 1 }, per_day: { min: 0, max: 2 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } });
  assert.equal(structuralForSilence(prev, added), true);
  const removed = structuredClone(prev);
  removed.platforms = removed.platforms.slice(0, 1);
  assert.equal(structuralForSilence(prev, removed), true);
});

test('a version built for a strategy directive or by a migration is structural', () => {
  const prev = pb();
  const same = structuredClone(prev);
  assert.equal(structuralForSilence(prev, same, { directiveId: 'd-1', createdBy: 'orchestrator' }), true);
  assert.equal(structuralForSilence(prev, same, { createdBy: 'migration' }), true);
  assert.equal(structuralForSilence(prev, same, { directiveId: null, createdBy: 'orchestrator' }), false);
});

test('a dropped or rewritten owner rule line is structural when the caller knows the owner lines', () => {
  const prev = pb();
  const next = structuredClone(prev);
  next.rules = ['Не більше двох емодзі'];
  assert.equal(structuralForSilence(prev, next), false, 'the playbook does not record a rule origin: unknown lines are not protected');
  assert.equal(structuralForSilence(prev, next, { ownerRuleLines: ['Без астрології'] }), true);
  assert.equal(structuralForSilence(prev, next, { ownerRuleLines: ['Не більше двох емодзі'] }), false, 'a kept owner line is fine');
});

test('with no active version there is nothing to compare: the version waits', () => {
  assert.equal(structuralForSilence(null, pb()), true);
});
