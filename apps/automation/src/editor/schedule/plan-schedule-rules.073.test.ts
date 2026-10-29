// Spec 073 FR-011 / A54, single planner: a series instance the skeleton check excluded (its format cannot be produced here, its time is
// inside the quiet hours) is not due, is refused when a slot names it, leaves a config placeholder, and the day's minimum loses it
// while the day's maximum is raised to the series instances that are due (the series is authoritative).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../roles/plan-rules';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import { makeCard } from '../post/testing/fixtures';
import { zonedToUtc } from '../roles/time';
import { dueInstances, dueOn, excludedOn, isExcludedAt, planScheduleErrors, scheduleBlock, type ExcludedInstance, type PlanScheduleCtx } from './plan-schedule-rules';
import { EMPTY_DAY_ERROR_RE, excludedPlaceholders } from './empty-day';
import { isConfigCode } from '../readiness/slot-config';
import { classifyClose } from '../series-pause/skip-cause';
import { skipGroupOf } from '../silent/skip-reasons';

const CH = '@food';
const TG = `telegram:${CH}`;
const DATE = '2026-10-07';                          // Wednesday
const NOW = new Date('2026-10-07T04:00:00Z');       // 07:00 Kyiv (UTC+3)
const card = makeCard({ channelKey: CH, timezone: 'Europe/Kyiv', postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, formats: { photo: 1, text: 1 } });

const NIGHT = { name: 'Нічна', cadence: 'daily@23:30', resource_ref: TG, format: 'photo', brief: 'Нічна серія з бібліотеки', locked: true, origin: 'owner' };
const RECIPE = { name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Рецепт з бібліотеки щовечора', locked: true, origin: 'owner' };
const playbook = (series: unknown[]): Playbook => PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }], series,
});

const AT = zonedToUtc(DATE, '23:30', 'Europe/Kyiv');
const NIGHT_EXCLUDED: ExcludedInstance = {
  series: 'Нічна', resourceRef: TG, at: AT, code: 'series_in_quiet_hours', detail: 'series "Нічна" posts at 23:30, inside the quiet hours 23:00-8:00',
};

function ctx(series: unknown[], excluded?: ExcludedInstance[]): PlanScheduleCtx {
  return {
    planDate: DATE, defaultRef: TG, now: NOW, clocks: { [TG]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 }, gapMin: 60 } },
    rules: [], pins: [], series: playbook(series).series, checkSlotSeries: true, ...(excluded ? { excluded } : {}),
  };
}
const slot = (time: string, extra: Record<string, unknown> = {}) => ({ time, format: 'photo', topic: 'Тема поста про їжу', source_hints: [] as string[], is_experiment: false, ...extra });
const errorsOf = (v: { ok: boolean }) => (v.ok ? '' : (v as any).errors.join('\n'));
const REASON_UK = 'Час серії припадає на тихі години';

test('the bug this fixes: without the exclusion a series at 23:30 in quiet hours cannot be planned and the plan is invalid', () => {
  const c = ctx([NIGHT, RECIPE]);
  const v = validatePlan({ rationale: 'Рецепт ввечері, нічну пропускаю', slots: [slot('19:00', { series: 'Рецепт дня' })] }, card, DATE, NOW, [], c);
  assert.equal(v.ok, false);
  assert.match(errorsOf(v), /серія «Нічна».*23:30/, 'the series is demanded, and 23:30 is a quiet hour the validator refuses to plan');
});

test('A54 an excluded instance is not due: dueInstances leaves it out, the plan needs no slot for it, and a config placeholder is written', () => {
  const c = ctx([NIGHT, RECIPE], [NIGHT_EXCLUDED]);
  assert.deepEqual(dueInstances(c).map((d) => d.series.name), ['Рецепт дня']);
  assert.equal(dueOn(c, TG), 1);
  assert.equal(excludedOn(c, TG), 1);
  assert.equal(isExcludedAt(c, 'Нічна', TG, AT), true);
  assert.equal(isExcludedAt(c, 'Нічна', TG, new Date(AT.getTime() + 60_000)), false, 'matched by the instant, not by the day');
  const v = validatePlan({ rationale: 'Рецепт ввечері, нічна виключена', slots: [slot('19:00', { series: 'Рецепт дня' })] }, card, DATE, NOW, [], c);
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  assert.equal(v.empty.length, 1);
  const e = v.empty[0];
  assert.equal(e.seriesName, 'Нічна');
  assert.equal(e.resourceRef, null, 'the anchor channel is stored without a resource_ref');
  assert.equal(e.scheduledAt.getTime(), AT.getTime());
  assert.equal(e.format, 'photo');
  assert.deepEqual(e.sourceHints, ['series:Нічна']);
  assert.equal(e.error, `series_in_quiet_hours: ${NIGHT_EXCLUDED.detail}`);
  // The placeholder is a config slot: the SQL regex finds it, the skip group is config, the breaker ignores it.
  assert.match(e.error, new RegExp(EMPTY_DAY_ERROR_RE));
  assert.equal(skipGroupOf(e.error), 'config');
  assert.equal(isConfigCode('series_in_quiet_hours'), true);
  assert.deepEqual(classifyClose({ status: 'skipped', error: e.error }), { k: 'ignore' });
});

test('A54 a slot that names an excluded instance is refused with the catalogue\'s reason; the series is not reported «не за розкладом»', () => {
  const c = ctx([NIGHT, RECIPE], [NIGHT_EXCLUDED]);
  const v = validatePlan({ rationale: 'Нічну ставлю в обід', slots: [slot('19:00', { series: 'Рецепт дня' }), slot('12:00', { series: 'Нічна' })] }, card, DATE, NOW, [], c);
  assert.equal(v.ok, false);
  const e = errorsOf(v);
  assert.match(e, new RegExp(`серія «Нічна» ${DATE} виключена: ${REASON_UK}`));
  assert.doesNotMatch(e, /не за розкладом/);
  // At its own instant the slot is refused for the same reason (plus the quiet hour it also breaks).
  const atTime = planScheduleErrors({ slots: [{ time: '23:30', series: 'Нічна' }] }, c, TG);
  assert.ok(atTime.some((x) => /виключена/.test(x)));
});

test('A54 a series with one excluded and one due instance: the due one is still owed, the excluded one is not', () => {
  const two = { ...NIGHT, name: 'Двічі', cadence: 'daily@12:00,23:30' };
  const ex: ExcludedInstance = { ...NIGHT_EXCLUDED, series: 'Двічі' };
  const c = ctx([two], [ex]);
  assert.deepEqual(dueInstances(c).map((d) => d.time), ['12:00']);
  const missing = validatePlan({ rationale: 'Нічого не планую зовсім', slots: [slot('15:00')] }, card, DATE, NOW, [], c);
  assert.equal(missing.ok, false);
  assert.match(errorsOf(missing), /серія «Двічі».*12:00/, 'the 12:00 instance is still required');
  const ok = validatePlan({ rationale: 'Опівдні серія, ніч виключена', slots: [slot('12:15', { series: 'Двічі' })] }, card, DATE, NOW, [], c);
  assert.equal(ok.ok, true, errorsOf(ok));
  if (ok.ok) assert.deepEqual(ok.empty.map((x) => x.scheduledAt.getTime()), [AT.getTime()]);
});

test('A54 the day\'s minimum loses the excluded instance: a day whose only owed post is excluded may be empty', () => {
  const only = ctx([NIGHT], [NIGHT_EXCLUDED]);
  const empty = validatePlan({ rationale: 'Єдина серія виключена, нічого планувати', slots: [] }, card, DATE, NOW, [], only);
  assert.equal(empty.ok, true, errorsOf(empty));
  if (empty.ok) assert.equal(empty.empty.length, 1, 'but the owner sees the placeholder');
  const control = validatePlan({ rationale: 'Те саме без виключення серії', slots: [] }, card, DATE, NOW, [], ctx([NIGHT]));
  assert.equal(control.ok, false, 'without the exclusion the minimum of 1 stays');
});

test('FR-011 the day\'s maximum is raised to the due series instances; extra posts beyond that still hit the card\'s maximum', () => {
  const three = [
    { ...RECIPE, name: 'Ранок', cadence: 'daily@09:00' }, { ...RECIPE, name: 'День', cadence: 'daily@13:00' }, { ...RECIPE, name: 'Вечір', cadence: 'daily@19:00' },
  ];
  const small = makeCard({ channelKey: CH, timezone: 'Europe/Kyiv', postsPerDayMin: 1, postsPerDayMax: 1, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, formats: { photo: 1, text: 1 } });
  const c = ctx(three);
  const ok = validatePlan({ rationale: 'Три серії понад максимум картки', slots: [slot('09:00', { series: 'Ранок' }), slot('13:00', { series: 'День' }), slot('19:00', { series: 'Вечір' })] }, small, DATE, NOW, [], c);
  assert.equal(ok.ok, true, errorsOf(ok));
  const extra = validatePlan({
    rationale: 'Три серії й ще один пост',
    slots: [slot('09:00', { series: 'Ранок' }), slot('11:00', { format: 'text', topic: 'Додатковий пост без серії' }), slot('13:00', { series: 'День' }), slot('19:00', { series: 'Вечір' })],
  }, small, DATE, NOW, [], c);
  assert.equal(extra.ok, false);
  assert.match(errorsOf(extra), /має бути 1–3, зараз 4/);
  // Without a schedule context nothing changes.
  const plain = validatePlan({ rationale: 'Без контексту розкладу', slots: [slot('10:00'), slot('12:00')] }, small, DATE, NOW);
  assert.match(errorsOf(plain), /має бути 1–1, зараз 2/);
});

test('A53 the planner block tells the planner not to plan the instance, with the Ukrainian reason, once per series and reason', () => {
  const block = scheduleBlock(ctx([NIGHT, RECIPE], [NIGHT_EXCLUDED, { ...NIGHT_EXCLUDED, at: new Date(AT.getTime() + 86_400_000) }]));
  assert.ok(block);
  assert.ok(block!.includes(`- не плануй «Нічна»: ${REASON_UK}`), block!);
  assert.equal(block!.split('не плануй «Нічна»').length - 1, 1, 'one line even with two excluded instances');
  assert.doesNotMatch(block!, /- серія «Нічна»/, 'and it is not listed as due');
  assert.match(block!, /- серія «Рецепт дня»/);
  const noEntry = scheduleBlock(ctx([NIGHT], [{ ...NIGHT_EXCLUDED, code: 'not_in_the_catalogue', detail: 'English detail' }]));
  assert.ok(noEntry!.includes('- не плануй «Нічна»: English detail'), 'a code without an entry falls back to the English detail');
});

test('excludedPlaceholders: one per excluded instance, the anchor as null and another resource by ref; none without an exclusion', () => {
  assert.deepEqual(excludedPlaceholders(ctx([NIGHT]), TG), []);
  const ig = { ...NIGHT, name: 'IG фото', resource_ref: 'instagram:ig1', format: 'ig_photo' };
  const c = { ...ctx([NIGHT, ig]), clocks: { ...ctx([]).clocks, 'instagram:ig1': { tz: 'America/New_York', quiet: { start: 22, end: 7 }, gapMin: 0 } } };
  const out = excludedPlaceholders(
    { series: c.series, excluded: [NIGHT_EXCLUDED, { series: 'IG фото', resourceRef: 'instagram:ig1', at: new Date('2026-10-07T13:00:00Z'), code: 'series_format_unavailable', detail: 'series "IG фото" format ig_photo cannot be produced' }] },
    TG,
  );
  assert.deepEqual(out.map((e) => [e.seriesName, e.resourceRef, e.format]), [['Нічна', null, 'photo'], ['IG фото', 'instagram:ig1', 'ig_photo']]);
  assert.match(out[1].error, /^series_format_unavailable: /);
  assert.match(out[1].error, new RegExp(EMPTY_DAY_ERROR_RE));
});
