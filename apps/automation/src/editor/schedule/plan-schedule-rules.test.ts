import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../roles/plan-rules';
import { validateNetworkPlan } from '../network/network-plan';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import type { NetworkCtx } from '../network/network-context';
import { makeCard } from '../post/testing/fixtures';
import { planPerDay, PlanScheduleCtx, scheduleBlock } from './plan-schedule-rules';
import type { ScheduleRule } from './schedule-rules';

// Spec 023 T4: blackout, pins, frequency and due/skip series rules in BOTH planners. Every resource carries an
// explicit clock (spec 024), so nothing here depends on the time of day the tests run.

const CH = '@food';
const TG = `telegram:${CH}`;
const IG = 'instagram:ig1';
const card = makeCard({ channelKey: CH, postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, formats: { photo: 1, text: 1 } });
const DATE = '2026-10-07'; // Wednesday
const NOW = new Date('2026-10-07T04:00:00Z'); // 07:00 Kyiv

const rule = (o: Partial<ScheduleRule>): ScheduleRule => ({
  id: o.id ?? 'r1', agentId: 'a1', resourceRef: TG, kind: 'blackout', days: null, atLocal: null, untilLocal: null, windowMin: 20,
  format: null, seriesName: null, brief: null, source: null, perDayMin: null, perDayMax: null, validFrom: null, validUntil: null,
  active: true, createdBy: 'owner', note: null, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), ...o,
});

const playbook = (series: unknown[] = []): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } },
    { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 0, max: 2 } },
  ],
  series,
});

const RECIPE = { name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Рецепт з бібліотеки щовечора', locked: true, origin: 'owner' };
const TIP = { name: 'Порада', cadence: 'weekly:wed@12:00', resource_ref: TG, format: 'text', brief: 'Коротка кухонна порада дня' };

function ctx(o: Partial<PlanScheduleCtx> = {}): PlanScheduleCtx {
  return {
    planDate: DATE, defaultRef: TG, now: NOW,
    clocks: { [TG]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 }, gapMin: 60 }, [IG]: { tz: 'America/New_York', quiet: { start: 22, end: 7 }, gapMin: 60 } },
    rules: [], pins: [], series: playbook([RECIPE, TIP]).series, checkSlotSeries: true, ...o,
  };
}

const slot = (time: string, extra: Record<string, unknown> = {}) => ({ time, format: 'photo', topic: 'Тема поста про їжу', source_hints: [] as string[], is_experiment: false, ...extra });
const errorsOf = (v: { ok: boolean }) => (v.ok ? '' : (v as any).errors.join('\n'));

test('single planner: a plan missing a due locked series is rejected; planned within ±90 min it passes', () => {
  const missing = validatePlan({ rationale: 'План без серії власника', slots: [slot('10:00'), slot('12:30', { series: 'Порада', format: 'text' })] }, card, DATE, NOW, [], ctx());
  assert.equal(missing.ok, false);
  assert.match(errorsOf(missing), /Рецепт дня.*19:00/);

  const ok = validatePlan({ rationale: 'План із серіями власника', slots: [slot('12:30', { series: 'Порада', format: 'text' }), slot('20:15', { series: 'Рецепт дня' })] }, card, DATE, NOW, [], ctx());
  assert.equal(ok.ok, true, errorsOf(ok));
  if (ok.ok) assert.deepEqual(ok.slots[1].sourceHints, ['series:Рецепт дня']);

  const far = validatePlan({ rationale: 'Серія надто далеко від часу', slots: [slot('12:00', { series: 'Порада', format: 'text' }), slot('16:00', { series: 'Рецепт дня' })] }, card, DATE, NOW, [], ctx());
  assert.equal(far.ok, false);
  assert.match(errorsOf(far), /Рецепт дня/);
});

test('single planner: an unlocked series may be skipped with a reason; a locked one may not', () => {
  const skipTip = validatePlan({
    rationale: 'Пропускаю пораду сьогодні', slots: [slot('19:00', { series: 'Рецепт дня' })],
    skipped_series: [{ name: 'Порада', reason: 'Сьогодні немає свіжої поради — краще пропустити' }],
  }, card, DATE, NOW, [], ctx());
  assert.equal(skipTip.ok, true, errorsOf(skipTip));

  const skipLocked = validatePlan({
    rationale: 'Пропускаю все', slots: [slot('12:00', { series: 'Порада', format: 'text' })],
    skipped_series: [{ name: 'Рецепт дня', reason: 'Не хочу сьогодні рецептів, вистачить' }],
  }, card, DATE, NOW, [], ctx());
  assert.equal(skipLocked.ok, false);
  assert.match(errorsOf(skipLocked), /заблокував власник/);

  const notDue = validatePlan({
    rationale: 'Серія не за розкладом', slots: [slot('12:00', { series: 'Порада', format: 'text' }), slot('19:00', { series: 'Рецепт дня' }), slot('21:00', { series: 'Неіснуюча' })],
  }, card, DATE, NOW, [], ctx());
  assert.equal(notDue.ok, false);
  assert.match(errorsOf(notDue), /Неіснуюча.*не за розкладом/);
});

test('single planner: a late start does not require instances that already passed', () => {
  const late = new Date('2026-10-07T15:00:00Z'); // 18:00 Kyiv: 12:00 (+90) has passed, 19:00 still due
  const v = validatePlan({ rationale: 'Пізній старт, лише рецепт', slots: [slot('19:00', { series: 'Рецепт дня' })] }, card, DATE, late, [], ctx({ now: late }));
  assert.equal(v.ok, true, errorsOf(v));
});

test('blackout: a planned slot inside the window is an error (also wrapping past midnight)', () => {
  const rules = [rule({ atLocal: '13:00', untilLocal: '15:00' }), rule({ id: 'r2', atLocal: '22:00', untilLocal: '09:00', days: [2] })]; // Tue 22:00 → Wed 09:00
  const v = validatePlan({
    rationale: 'Слоти у заборонених вікнах', slots: [slot('08:30'), slot('12:00', { series: 'Порада', format: 'text' }), slot('14:00'), slot('19:00', { series: 'Рецепт дня' })],
  }, { ...card, quietEndHour: 7 }, DATE, NOW, [], ctx({ rules }));
  assert.equal(v.ok, false);
  const e = errorsOf(v);
  assert.match(e, /слот 1 \(08:30\): заборонене вікно власника 22:00–09:00/);
  assert.match(e, /слот 3 \(14:00\): заборонене вікно власника 13:00–15:00/);
  assert.doesNotMatch(e, /слот 2|слот 4/);
});

test('blackout: a due series inside a blackout is not required', () => {
  const v = validatePlan({ rationale: 'Порада в забороненому вікні', slots: [slot('19:00', { series: 'Рецепт дня' })] }, card, DATE, NOW, [],
    ctx({ rules: [rule({ atLocal: '11:00', untilLocal: '13:00' })] }));
  assert.equal(v.ok, true, errorsOf(v));
});

test('pins: fixed slots keep their distance, cover their series and count toward per_day', () => {
  const pins = [{ resourceRef: TG, at: new Date('2026-10-07T16:00:00Z'), ruleId: 'p1', seriesName: 'Рецепт дня', windowMin: 20 }]; // 19:00 Kyiv
  const c = ctx({ pins, rules: [rule({ id: 'p1', kind: 'pin', atLocal: '19:00', seriesName: 'Рецепт дня' })] });
  const eff = { ...card, ...planPerDay(c, TG, { min: card.postsPerDayMin, max: card.postsPerDayMax }) };
  assert.deepEqual([eff.min, eff.max], [0, 3]);
  const tooClose = validatePlan({ rationale: 'Слот біля закріпленого', slots: [slot('12:00', { series: 'Порада', format: 'text' }), slot('19:30')] },
    { ...card, postsPerDayMin: eff.min, postsPerDayMax: eff.max }, DATE, NOW, [], c);
  assert.equal(tooClose.ok, false);
  assert.match(errorsOf(tooClose), /закріпленого поста власника о 19:00/);
  // The pin is the recipe instance: no series slot is needed for it.
  const ok = validatePlan({ rationale: 'Порада + закріплений рецепт', slots: [slot('12:00', { series: 'Порада', format: 'text' })] },
    { ...card, postsPerDayMin: eff.min, postsPerDayMax: eff.max }, DATE, NOW, [], c);
  assert.equal(ok.ok, true, errorsOf(ok));
  const tooMany = validatePlan({ rationale: 'Забагато разом із пінами', slots: ['10:00', '12:00', '14:00', '21:00'].map((t) => slot(t, t === '12:00' ? { series: 'Порада', format: 'text' } : {})) },
    { ...card, postsPerDayMin: eff.min, postsPerDayMax: eff.max }, DATE, NOW, [], c);
  assert.equal(tooMany.ok, false);
  assert.match(errorsOf(tooMany), /кількість постів/);
});

test('frequency: the rule overrides posts per day for its dates only', () => {
  const rules = [rule({ kind: 'frequency', perDayMin: 2, perDayMax: 2, days: [3] })];
  assert.deepEqual(planPerDay(ctx({ rules }), TG, { min: 1, max: 4 }), { min: 2, max: 2 });
  assert.deepEqual(planPerDay(ctx({ rules, planDate: '2026-10-08' }), TG, { min: 1, max: 4 }), { min: 1, max: 4 });
  assert.deepEqual(planPerDay(ctx({ rules: [rule({ kind: 'frequency', perDayMax: 1, validUntil: '2026-10-06' })] }), TG, { min: 1, max: 4 }), { min: 1, max: 4 });
});

// ── the network planner ────────────────────────────────────────────────────

const NET_PB = playbook([RECIPE, { name: 'IG фото', cadence: 'daily@09:00', resource_ref: IG, format: 'ig_photo', brief: 'Фото страви дня для Instagram' }]);
const net = (pb: Playbook = NET_PB): NetworkCtx => ({
  orchestrator: { id: 'a1', handle: 'chef', mode: 'live' } as any, anchorKey: CH, groupId: 'g1', groupName: 'Food', mode: 'independent',
  resources: [{ ref: TG, platform: 'telegram', tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } }, { ref: IG, platform: 'instagram', tz: 'America/New_York', quiet: { start: 22, end: 7 } }],
  playbook: pb, playbookVersion: 3, telegramFormats: ['photo', 'text'],
});
const nslot = (ref: string, time: string, extra: Record<string, unknown> = {}) => ({ resource_ref: ref, time, format: ref === IG ? 'ig_photo' : 'photo', topic: 'Тема поста про їжу', source_hints: [] as string[], ...extra });

test('network planner: due series per resource zone, blackout and frequency through the same rules', () => {
  const c = ctx({ series: NET_PB.series, checkSlotSeries: false });
  const base = { card, planDate: DATE, weekday: 3, now: NOW, ideas: new Map(), reservedAt: [] as Date[] };
  // IG's 09:00 is New York time: 13:00Z. Telegram 19:00 Kyiv is 16:00Z.
  const ok = validateNetworkPlan({ rationale: 'Обидві серії', slots: [nslot(TG, '19:00', { series: 'Рецепт дня' }), nslot(IG, '09:30', { series: 'IG фото' })] }, { ...base, net: net(), schedule: c });
  assert.equal(ok.ok, true, errorsOf(ok));

  const missing = validateNetworkPlan({ rationale: 'Забув інстаграм', slots: [nslot(TG, '19:00', { series: 'Рецепт дня' })] }, { ...base, net: net(), schedule: c });
  assert.equal(missing.ok, false);
  assert.match(errorsOf(missing), /IG фото.*09:00.*America\/New_York/);

  const blackout = ctx({ series: NET_PB.series, checkSlotSeries: false, rules: [rule({ resourceRef: IG, atLocal: '09:00', untilLocal: '10:00' })] });
  const inside = validateNetworkPlan({ rationale: 'Слот у вікні', slots: [nslot(TG, '19:00', { series: 'Рецепт дня' }), nslot(IG, '09:30', { series: 'IG фото' })] }, { ...base, net: net(), schedule: blackout });
  assert.equal(inside.ok, false);
  assert.match(errorsOf(inside), /instagram:ig1 09:30\): заборонене вікно власника 09:00–10:00 \(America\/New_York\)/);

  // Frequency: Telegram exactly 2 today → one series post alone is too few (the caller passes the effective playbook).
  const freq = ctx({ series: NET_PB.series, checkSlotSeries: false, rules: [rule({ kind: 'frequency', perDayMin: 2, perDayMax: 2 })] });
  const eff: Playbook = { ...NET_PB, platforms: NET_PB.platforms.map((s) => ({ ...s, per_day: planPerDay(freq, s.resource_ref, s.per_day) })) };
  const few = validateNetworkPlan({ rationale: 'Мало постів', slots: [nslot(TG, '19:00', { series: 'Рецепт дня' }), nslot(IG, '09:30', { series: 'IG фото' })] }, { ...base, net: net(eff), schedule: freq });
  assert.equal(few.ok, false);
  assert.match(errorsOf(few), /telegram:@food: 1 постів < per_day.min 2/);
});

test('the planner prompt block lists pins, blackouts, frequency and due series', () => {
  const b = scheduleBlock(ctx({
    pins: [{ resourceRef: TG, at: new Date('2026-10-07T16:00:00Z'), ruleId: 'p1', seriesName: null, windowMin: 20 }],
    rules: [rule({ atLocal: '13:00', untilLocal: '15:00' }), rule({ id: 'f', kind: 'frequency', perDayMin: 1, perDayMax: 2 })],
  }))!;
  for (const frag of ['закріплений пост власника telegram:@food о 19:00', 'заборонене вікно telegram:@food: 13:00–15:00', 'частота telegram:@food сьогодні: 1–2', 'серія «Рецепт дня»', 'заблокована власником']) {
    assert.ok(b.includes(frag), `${frag}\n${b}`);
  }
  assert.equal(scheduleBlock(ctx({ series: [] })), null);
});
