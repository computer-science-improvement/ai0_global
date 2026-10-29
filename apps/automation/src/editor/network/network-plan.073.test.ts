// Spec 073 FR-011 / A54, network planner: the validator builds its own due map from the playbook, so the excluded instances
// (a format a resource cannot produce, a time inside its quiet hours) are dropped there too. A slot that names one is refused with
// the catalogue's reason, each leaves a config placeholder in `empty`, and the resource's minimum loses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNetworkPlan } from './network-plan';
import { PlaybookSchema, type Playbook } from './playbook';
import type { NetworkCtx } from './network-context';
import { makeCard } from '../post/testing/fixtures';
import { zonedToUtc } from '../roles/time';
import type { ExcludedInstance, PlanScheduleCtx } from '../schedule/plan-schedule-rules';
import { EMPTY_DAY_ERROR_RE } from '../schedule/empty-day';

const CH = '@food';
const TG = `telegram:${CH}`;
const IG = 'instagram:ig1';
const DATE = '2026-10-07';                          // Wednesday
const NOW = new Date('2026-10-07T04:00:00Z');       // 07:00 Kyiv (UTC+3)
const card = makeCard({ channelKey: CH, timezone: 'Europe/Kyiv', postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, formats: { photo: 1, text: 1 } });

const NIGHT = { name: 'Нічна', cadence: 'daily@23:30', resource_ref: TG, format: 'photo', brief: 'Нічна серія з бібліотеки', locked: true, origin: 'owner' };
const IG_SERIES = { name: 'IG фото', cadence: 'daily@09:00', resource_ref: IG, format: 'ig_photo', brief: 'Фото страви дня для Instagram' };
const IG_TWICE = { name: 'IG двічі', cadence: 'daily@09:00,12:00', resource_ref: IG, format: 'ig_photo', brief: 'Фото страви двічі на день' };
const playbook = (series: unknown[]): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } },
    { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 1, max: 2 } },
  ],
  series,
});
const net = (pb: Playbook): NetworkCtx => ({
  orchestrator: { id: 'a1', handle: 'chef', mode: 'live' } as any, anchorKey: CH, groupId: 'g1', groupName: 'Food', mode: 'independent',
  resources: [{ ref: TG, platform: 'telegram', tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } }, { ref: IG, platform: 'instagram', tz: 'America/New_York', quiet: { start: 22, end: 7 } }],
  playbook: pb, playbookVersion: 3, telegramFormats: ['photo', 'text'],
});
const AT = zonedToUtc(DATE, '23:30', 'Europe/Kyiv');
const NIGHT_EXCLUDED: ExcludedInstance = { series: 'Нічна', resourceRef: TG, at: AT, code: 'series_in_quiet_hours', detail: 'series "Нічна" posts at 23:30, inside the quiet hours 23:00-8:00' };

function ctx(pb: Playbook, excluded?: ExcludedInstance[]): PlanScheduleCtx {
  return {
    planDate: DATE, defaultRef: TG, now: NOW,
    clocks: { [TG]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 }, gapMin: 60 }, [IG]: { tz: 'America/New_York', quiet: { start: 22, end: 7 }, gapMin: 0 } },
    rules: [], pins: [], series: pb.series, checkSlotSeries: false, ...(excluded ? { excluded } : {}),
  };
}
const base = { card, planDate: DATE, weekday: 3, now: NOW, ideas: new Map(), reservedAt: [] as Date[] };
const nslot = (ref: string, time: string, extra: Record<string, unknown> = {}) => ({ resource_ref: ref, time, format: ref === IG ? 'ig_photo' : 'photo', topic: 'Тема поста про їжу', source_hints: [] as string[], ...extra });
const errorsOf = (v: { ok: boolean }) => (v.ok ? '' : (v as any).errors.join('\n'));
const REASON_UK = 'Час серії припадає на тихі години';

test('the bug this fixes: without the exclusion the network planner is asked for a series it cannot plan', () => {
  const pb = playbook([NIGHT, IG_SERIES]);
  const v = validateNetworkPlan({ rationale: 'Інстаграм є, нічну не планую', slots: [nslot(IG, '09:30', { series: 'IG фото' })] }, { ...base, net: net(pb), schedule: ctx(pb) });
  assert.equal(v.ok, false);
  assert.match(errorsOf(v), /серія «Нічна».*23:30/);
});

test('A54 the network validator drops the excluded instance from its due map: no slot is demanded, the placeholder comes back in `empty`, the minimum loses it', () => {
  const pb = playbook([NIGHT, IG_SERIES]);
  const v = validateNetworkPlan({ rationale: 'Інстаграм є, нічна виключена', slots: [nslot(IG, '09:30', { series: 'IG фото' })] }, { ...base, net: net(pb), schedule: ctx(pb, [NIGHT_EXCLUDED]) });
  // Telegram has no slot at all: its minimum of 1 lost the excluded instance, so it needs none.
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  assert.equal(v.empty.length, 1);
  assert.deepEqual([v.empty[0].seriesName, v.empty[0].resourceRef, v.empty[0].scheduledAt.getTime()], ['Нічна', null, AT.getTime()]);
  assert.equal(v.empty[0].error, `series_in_quiet_hours: ${NIGHT_EXCLUDED.detail}`);
  assert.match(v.empty[0].error, new RegExp(EMPTY_DAY_ERROR_RE));
});

test('A54 a slot that names an excluded instance is refused with the catalogue\'s reason, not as «не за розкладом» and not as a format error', () => {
  const pb = playbook([NIGHT, IG_SERIES]);
  const v = validateNetworkPlan({
    rationale: 'Нічну ставлю в обід',
    slots: [nslot(IG, '09:30', { series: 'IG фото' }), nslot(TG, '12:00', { series: 'Нічна' })],
  }, { ...base, net: net(pb), schedule: ctx(pb, [NIGHT_EXCLUDED]) });
  assert.equal(v.ok, false);
  const e = errorsOf(v);
  assert.match(e, new RegExp(`серія «Нічна» ${DATE} виключена: ${REASON_UK}`));
  assert.doesNotMatch(e, /не за розкладом/);
  assert.doesNotMatch(e, /не дозволений плейбуком/);
});

test('A54 a series with one excluded and one due instance stays in the due map: its due instance is still owed', () => {
  const night = { ...NIGHT, name: 'Двічі', cadence: 'daily@12:00,23:30', brief: 'Серія двічі на день з бібліотеки' };
  const pb = playbook([night, IG_SERIES]);
  const c = ctx(pb, [{ ...NIGHT_EXCLUDED, series: 'Двічі' }]);
  const missing = validateNetworkPlan({ rationale: 'Тільки інстаграм, телеграм забув', slots: [nslot(IG, '09:30', { series: 'IG фото' })] }, { ...base, net: net(pb), schedule: c });
  assert.equal(missing.ok, false);
  assert.match(errorsOf(missing), /серія «Двічі».*12:00/);
  const ok = validateNetworkPlan({ rationale: 'Обидві серії, ніч виключена', slots: [nslot(IG, '09:30', { series: 'IG фото' }), nslot(TG, '12:00', { series: 'Двічі' })] }, { ...base, net: net(pb), schedule: c });
  assert.equal(ok.ok, true, errorsOf(ok));
  if (ok.ok) assert.deepEqual(ok.empty.map((e) => e.scheduledAt.getTime()), [AT.getTime()]);
});

test('A54 a format the resource cannot produce excludes the instance on its own resource (the other resource is not touched)', () => {
  const pb = playbook([NIGHT, IG_SERIES, IG_TWICE]);
  // «IG двічі» 09:00 and 12:00 New York: the whole series cannot be produced here; «IG фото» can.
  const at = (time: string) => zonedToUtc(DATE, time, 'America/New_York');
  const excluded: ExcludedInstance[] = ['09:00', '12:00'].map((t) => ({
    series: 'IG двічі', resourceRef: IG, at: at(t), code: 'series_format_unavailable', detail: 'series "IG двічі" format ig_photo cannot be produced on instagram:ig1',
  }));
  const c = ctx(pb, [NIGHT_EXCLUDED, ...excluded]);
  const v = validateNetworkPlan({ rationale: 'Лише серія, що можлива', slots: [nslot(IG, '09:30', { series: 'IG фото' })] }, { ...base, net: net(pb), schedule: c });
  assert.equal(v.ok, true, errorsOf(v));
  if (v.ok) {
    assert.equal(v.empty.length, 3, 'one placeholder per excluded instance');
    assert.deepEqual(v.empty.filter((e) => e.resourceRef === IG).map((e) => e.error.split(':')[0]), ['series_format_unavailable', 'series_format_unavailable']);
  }
  const named = validateNetworkPlan({ rationale: 'Серія, що неможлива', slots: [nslot(IG, '09:30', { series: 'IG фото' }), nslot(IG, '12:20', { series: 'IG двічі' })] }, { ...base, net: net(pb), schedule: c });
  assert.equal(named.ok, false);
  assert.match(errorsOf(named), /серія «IG двічі» 2026-10-07 виключена: Формат серії тут не можна зробити/);
});
