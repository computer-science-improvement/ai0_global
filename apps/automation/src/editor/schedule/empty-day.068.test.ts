// Spec 068 T2 (FR-004, FR-005): an honest empty day. A planner with nothing to post from says so (`skipped_series[].cause`,
// `short_day`, `short_days`) and the code lowers the day's minimum and records placeholder slots; the planners' per-day
// bounds lose the instances of paused series. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubmitPlanInput, validatePlan } from '../roles/plan-rules';
import { SubmitNetworkPlanInput, validateNetworkPlan } from '../network/network-plan';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import type { NetworkCtx } from '../network/network-context';
import { makeCard } from '../post/testing/fixtures';
import { EMPTY_DAY_WAY_OUT, minAfterPauses, pausedInstances, planPerDay, type PausedSeriesCtx, type PlanScheduleCtx } from './plan-schedule-rules';
import { EMPTY_DAY_ERROR_RE, emptyDayError, shortDayPlaceholder } from './empty-day';
import type { IdeaRow } from '../network/network.repository';
import type { ScheduleRule } from './schedule-rules';

const rule = (o: Partial<ScheduleRule>): ScheduleRule => ({
  id: o.id ?? 'r1', agentId: 'a1', resourceRef: TG, kind: 'blackout', days: null, atLocal: null, untilLocal: null, windowMin: 20,
  format: null, seriesName: null, brief: null, source: null, perDayMin: null, perDayMax: null, validFrom: null, validUntil: null,
  active: true, createdBy: 'owner', note: null, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), ...o,
});

const CH = '@food';
const TG = `telegram:${CH}`;
const IG = 'instagram:ig1';
const DATE = '2026-10-07';                          // Wednesday
const NOW = new Date('2026-10-07T04:00:00Z');       // 07:00 Kyiv (UTC+3)
const card = makeCard({ channelKey: CH, postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, formats: { photo: 1, text: 1 } });

const RECIPE = { name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Рецепт з бібліотеки щовечора', locked: true, origin: 'owner' };
const TIP = { name: 'Порада', cadence: 'weekly:wed@12:00', resource_ref: TG, format: 'text', brief: 'Коротка кухонна порада дня' };
const STORY = { name: 'Історія', cadence: 'daily@15:00', resource_ref: IG, format: 'ig_photo', brief: 'Історія дня для Instagram' };

const playbook = (series: unknown[] = []): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } },
    { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 1, max: 2 } },
  ],
  series,
});

function ctx(o: Partial<PlanScheduleCtx> = {}, series: unknown[] = [RECIPE, TIP]): PlanScheduleCtx {
  return {
    planDate: DATE, defaultRef: TG, now: NOW,
    clocks: { [TG]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 }, gapMin: 60 }, [IG]: { tz: 'America/New_York', quiet: { start: 22, end: 7 }, gapMin: 60 } },
    rules: [], pins: [], series: playbook(series).series, checkSlotSeries: true, ...o,
  };
}
const slot = (time: string, extra: Record<string, unknown> = {}) => ({ time, format: 'photo', topic: 'Тема поста про їжу', source_hints: [] as string[], is_experiment: false, ...extra });
const errorsOf = (v: { ok: boolean }) => (v.ok ? '' : (v as any).errors.join('\n'));
const REASON = 'Бібліотека порожня, джерела картки вичерпані';

// ── single planner ──────────────────────────────────────────────────────────

test('a short count names the way out; short_day lowers the minimum to 0 and leaves one placeholder', () => {
  const plain = validatePlan({ rationale: 'Нічого не планую сьогодні', slots: [] }, card, DATE, NOW, [], ctx({}, []));
  assert.equal(plain.ok, false);
  assert.match(errorsOf(plain), /кількість постів/);
  assert.ok(errorsOf(plain).includes(EMPTY_DAY_WAY_OUT), 'the refusal says what to do when there is no material');
  assert.match(EMPTY_DAY_WAY_OUT, /cause: no_material/);
  assert.match(EMPTY_DAY_WAY_OUT, /short_day/);

  const v = validatePlan({ rationale: 'Нічого немає з чого писати', slots: [], short_day: { cause: 'no_material', reason: REASON } }, card, DATE, NOW, [], ctx({}, []));
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  assert.equal(v.slots.length, 0);
  assert.equal(v.empty.length, 1);
  const e = v.empty[0];
  assert.equal(e.resourceRef, null, 'the anchor channel itself');
  assert.equal(e.seriesName, null);
  assert.equal(e.format, 'text');
  assert.equal(e.topic, `Порожній день: ${REASON}`);
  assert.deepEqual(e.sourceHints, []);
  assert.equal(e.error, `planner_no_material: ${REASON}`);
  assert.equal(e.scheduledAt.toISOString(), NOW.toISOString(), 'the later of now and the start of the day');
  assert.deepEqual([e.day!.from.toISOString(), e.day!.to.toISOString()], ['2026-10-06T21:00:00.000Z', '2026-10-07T21:00:00.000Z']);
  assert.match(e.error, new RegExp(EMPTY_DAY_ERROR_RE), 'the repository finds it by this pattern');
});

test('short_day may come with slots, and the maximum still applies', () => {
  const with1 = validatePlan({ rationale: 'Одну пораду все ж є', slots: [slot('12:00', { format: 'text' })], short_day: { cause: 'source_unreachable', reason: 'Усі джерела картки віддають 403 уже добу' } }, card, DATE, NOW, [], ctx({}, []));
  assert.equal(with1.ok, true, errorsOf(with1));
  if (with1.ok) { assert.equal(with1.slots.length, 1); assert.equal(with1.empty[0].error.startsWith('planner_source_unreachable: '), true); }
  const tooMany = validatePlan({ rationale: 'Забагато слотів', slots: ['09:00', '11:00', '13:00', '15:00', '17:00'].map((t) => slot(t)), short_day: { cause: 'no_material', reason: REASON } }, card, DATE, NOW, [], ctx({}, []));
  assert.equal(tooMany.ok, false);
  assert.match(errorsOf(tooMany), /кількість постів/);
});

test('a short day later in the day starts at the day start only when now is before it', () => {
  const p = shortDayPlaceholder({ resourceRef: null, tz: 'Europe/Kyiv', planDate: '2026-10-08', now: NOW, cause: 'no_material', reason: REASON });
  assert.equal(p.scheduledAt.toISOString(), '2026-10-07T21:00:00.000Z', 'tomorrow: its local midnight, not now');
  assert.equal(emptyDayError('no_material', '  x  '), 'planner_no_material: x');
});

test('the input schema: short_day needs a cause and a real reason; skipped_series takes an optional cause', () => {
  const base = { rationale: 'Нічого немає з чого писати', slots: [] };
  assert.equal(SubmitPlanInput.safeParse({ ...base, short_day: { cause: 'no_material', reason: REASON } }).success, true);
  assert.equal(SubmitPlanInput.safeParse({ ...base, short_day: { cause: 'no_material', reason: 'коротко' } }).success, false, 'reason ≥ 20 chars');
  assert.equal(SubmitPlanInput.safeParse({ ...base, short_day: { cause: 'weird', reason: REASON } }).success, false);
  assert.equal(SubmitPlanInput.safeParse({ ...base, skipped_series: [{ name: 'Порада', reason: 'Немає свіжої поради сьогодні' }] }).success, true, 'cause is optional');
  assert.equal(SubmitPlanInput.safeParse({ ...base, skipped_series: [{ name: 'Порада', reason: 'Немає свіжої поради сьогодні', cause: 'no_material' }] }).success, true);
  assert.equal(SubmitPlanInput.safeParse({ ...base, skipped_series: [{ name: 'Порада', reason: 'Немає свіжої поради сьогодні', cause: 'lazy' }] }).success, false);
});

test('a series skipped with a material cause lowers the minimum by its instance and leaves a placeholder at its time', () => {
  const c = ctx({}, [TIP]);
  const reason = 'У бібліотеці порад немає нічого нового';
  const other = validatePlan({ rationale: 'Пропускаю пораду сьогодні', slots: [], skipped_series: [{ name: 'Порада', reason }] }, card, DATE, NOW, [], c);
  assert.equal(other.ok, false, 'no cause = other: the minimum stays');
  assert.match(errorsOf(other), /кількість постів/);

  const v = validatePlan({ rationale: 'Для поради немає матеріалу', slots: [], skipped_series: [{ name: 'Порада', reason, cause: 'no_material' }] }, card, DATE, NOW, [], c);
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  assert.equal(v.empty.length, 1);
  assert.deepEqual(
    { at: v.empty[0].scheduledAt.toISOString(), series: v.empty[0].seriesName, hints: v.empty[0].sourceHints, format: v.empty[0].format, topic: v.empty[0].topic, ref: v.empty[0].resourceRef, error: v.empty[0].error },
    { at: '2026-10-07T09:00:00.000Z', series: 'Порада', hints: ['series:Порада'], format: 'text', topic: 'Порожній випуск: Порада', ref: null, error: `planner_no_material: ${reason}` });

  const src = validatePlan({ rationale: 'Джерело поради не читається', slots: [], skipped_series: [{ name: 'Порада', reason, cause: 'source_unreachable' }] }, card, DATE, NOW, [], c);
  assert.equal(src.ok, true, errorsOf(src));
  if (src.ok) assert.equal(src.empty[0].error, `planner_source_unreachable: ${reason}`);
});

test('a locked series may be skipped only with a material cause', () => {
  const reason = 'Бібліотека рецептів порожня, нових немає';
  const base = { rationale: 'Рецепт сьогодні не з чого робити', slots: [slot('12:30', { series: 'Порада', format: 'text' })] };
  const none = validatePlan({ ...base, skipped_series: [{ name: 'Рецепт дня', reason }] }, card, DATE, NOW, [], ctx());
  assert.equal(none.ok, false);
  assert.match(errorsOf(none), /заблокував власник/);
  assert.match(errorsOf(none), /cause: no_material/, 'the refusal names the way out');
  const other = validatePlan({ ...base, skipped_series: [{ name: 'Рецепт дня', reason, cause: 'other' }] }, card, DATE, NOW, [], ctx());
  assert.equal(other.ok, false);

  const ok = validatePlan({ ...base, skipped_series: [{ name: 'Рецепт дня', reason, cause: 'no_material' }] }, card, DATE, NOW, [], ctx());
  assert.equal(ok.ok, true, errorsOf(ok));
  if (!ok.ok) return;
  assert.equal(ok.slots.length, 1);
  assert.deepEqual(ok.empty.map((e) => [e.seriesName, e.scheduledAt.toISOString()]), [['Рецепт дня', '2026-10-07T16:00:00.000Z']]);
});

test('an instance that is no longer required (late start, blackout) leaves no placeholder and takes nothing off the minimum', () => {
  const late = new Date('2026-10-07T15:00:00Z');                       // 18:00 Kyiv: the 12:00 tip has passed
  const v = validatePlan({ rationale: 'Пізній старт, поради вже не буде', slots: [], skipped_series: [{ name: 'Порада', reason: 'У бібліотеці порад немає нічого нового', cause: 'no_material' }] },
    card, DATE, late, [], ctx({ now: late }, [TIP]));
  assert.equal(v.ok, false, 'the minimum is 1 and nothing else covers it');
  const rules = [rule({ atLocal: '11:00', untilLocal: '13:00' })];
  const bo = validatePlan({ rationale: 'Порада у вікні власника', slots: [slot('19:00')], skipped_series: [{ name: 'Порада', reason: 'У бібліотеці порад немає нічого нового', cause: 'no_material' }] },
    card, DATE, NOW, [], ctx({ rules }, [TIP]));
  assert.equal(bo.ok, true, errorsOf(bo));
  if (bo.ok) assert.deepEqual(bo.empty, []);
});

// ── the network planner ─────────────────────────────────────────────────────

const RES = [{ ref: TG, platform: 'telegram' as const }, { ref: IG, platform: 'instagram' as const, tz: 'America/New_York' }];
const netCtx = (series: unknown[] = []): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: CH, groupId: 'g1', groupName: 'Кухня', mode: 'independent',
  resources: RES, playbook: playbook(series), playbookVersion: 1, telegramFormats: ['text', 'photo'],
});
const netOpts = (o: Record<string, unknown> = {}) => ({ net: netCtx(), card, planDate: DATE, weekday: 3, now: NOW, ideas: new Map([[I1, idea()]]), reservedAt: [] as Date[], ...o });
const I1 = '00000000-0000-4000-8000-000000000001';
const idea = (): IdeaRow => ({
  id: I1, agentId: 'o1', title: 'Ідея I1', angle: null, sources: ['https://x'], variants: [{ resource_ref: TG, format: 'text' }],
  why: null, evidence: null, origin: 'orchestrator', originRef: null, expiresAt: new Date(), status: 'accepted', revisions: 0, review: null, createdAt: new Date(), updatedAt: new Date(),
});
const tgPost = { resource_ref: TG, time: '12:00', format: 'text', topic: 'Порада про ніж', idea_id: I1, source_hints: [] as string[], reason: 'Ядро мережі: коротка порада' };
/** The idea goes to Telegram only: Instagram is a decided skip (every idea needs one decision per resource with a section). */
const igSkip = { idea_id: I1, resource_ref: IG, reason: 'Профіль IG — візуал, тут лише текст', reason_code: 'format_unfit' as const };

test('network: per_day.min per resource; a short day takes one resource to 0, the others keep theirs', () => {
  const plain = validateNetworkPlan({ rationale: 'Нічого не публікую сьогодні', slots: [] }, netOpts());
  assert.equal(plain.ok, false);
  const e = errorsOf(plain);
  assert.match(e, /telegram:@food: 0 постів < per_day\.min 1/);
  assert.match(e, /instagram:ig1: 0 постів < per_day\.min 1/);
  assert.ok(e.includes(EMPTY_DAY_WAY_OUT));

  const one = validateNetworkPlan({ rationale: 'Для Instagram немає матеріалу', slots: [tgPost], skips: [igSkip], short_days: [{ resource_ref: IG, cause: 'no_material', reason: 'Фото для Instagram у бібліотеці закінчились' }] }, netOpts());
  assert.equal(one.ok, true, errorsOf(one));
  if (!one.ok) return;
  assert.equal(one.empty.length, 1);
  assert.equal(one.empty[0].resourceRef, IG);
  assert.equal(one.empty[0].error, 'planner_no_material: Фото для Instagram у бібліотеці закінчились');
  assert.deepEqual([one.empty[0].day!.from.toISOString(), one.empty[0].day!.to.toISOString()], ['2026-10-07T04:00:00.000Z', '2026-10-08T04:00:00.000Z'], 'the day on the resource\'s own clock (New York, UTC-4)');

  const both = validateNetworkPlan({ rationale: 'Сьогодні немає з чого писати', slots: [], short_days: [
    { resource_ref: TG, cause: 'no_material', reason: REASON }, { resource_ref: IG, cause: 'source_unreachable', reason: 'Instagram API віддає 401 від ранку' },
  ] }, netOpts());
  assert.equal(both.ok, true, errorsOf(both));
  if (both.ok) assert.deepEqual(both.empty.map((x) => x.resourceRef), [null, IG], 'the anchor channel is stored without resource_ref');
});

test('network: short_days refuses a resource outside the network and a duplicate; the schema needs a real reason', () => {
  const bad = validateNetworkPlan({ rationale: 'Порожній день у мережі', slots: [tgPost], skips: [igSkip], short_days: [
    { resource_ref: 'tiktok:x', cause: 'no_material', reason: REASON }, { resource_ref: IG, cause: 'no_material', reason: REASON }, { resource_ref: IG, cause: 'no_material', reason: REASON },
  ] }, netOpts());
  assert.equal(bad.ok, false);
  assert.match(errorsOf(bad), /short_days: ресурс tiktok:x не в мережі/);
  assert.match(errorsOf(bad), /short_days: ресурс instagram:ig1 вказано двічі/);
  assert.equal(SubmitNetworkPlanInput.safeParse({ rationale: 'Порожній день у мережі', slots: [], short_days: [{ resource_ref: IG, cause: 'no_material', reason: 'ні' }] }).success, false);
});

test('network: a series skipped with a material cause lowers its resource\'s minimum and leaves a placeholder at its time there', () => {
  const schedule = ctx({ defaultRef: TG, checkSlotSeries: false }, [STORY]);
  const net = netCtx([STORY]);
  const reason = 'Фото для історій закінчились у бібліотеці';
  const plain = validateNetworkPlan({ rationale: 'Історії сьогодні не буде', slots: [tgPost], skips: [igSkip], skipped_series: [{ name: 'Історія', reason }] }, netOpts({ net, schedule }));
  assert.equal(plain.ok, false, 'cause other: instagram:ig1 keeps its minimum');
  assert.match(errorsOf(plain), /instagram:ig1: 0 постів < per_day\.min 1/);

  const v = validateNetworkPlan({ rationale: 'Історії сьогодні не буде', slots: [tgPost], skips: [igSkip], skipped_series: [{ name: 'Історія', reason, cause: 'no_material' }] }, netOpts({ net, schedule }));
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  assert.deepEqual(v.empty.map((e) => [e.seriesName, e.resourceRef, e.scheduledAt.toISOString(), e.format]), [['Історія', IG, '2026-10-07T19:00:00.000Z', 'ig_photo']]);
});

// ── the pauses lower the minimum (FR-005) ───────────────────────────────────

const pause = (name: string | null, resourceRef: string | null = null): PausedSeriesCtx => ({ name, resourceRef, label: name ?? String(resourceRef), streak: 3, reason: 'немає матеріалу' });

test('planPerDay: the instances of paused series come off the minimum; the maximum stays', () => {
  const base = { min: 2, max: 4 };
  assert.deepEqual(planPerDay(ctx(), TG, base), base, 'no pause: unchanged');
  assert.deepEqual(planPerDay(ctx({ paused: [pause('Рецепт дня')] }), TG, base), { min: 1, max: 4 });
  assert.deepEqual(planPerDay(ctx({ paused: [pause('Рецепт дня'), pause('Порада')] }), TG, base), { min: 0, max: 4 }, 'Wednesday: two instances');
  assert.deepEqual(planPerDay(ctx({ paused: [pause('Рецепт дня'), pause('Порада')], planDate: '2026-10-08' }), TG, base), { min: 1, max: 4 }, 'Thursday: the tip is not due');
  assert.equal(pausedInstances(ctx({ paused: [pause('Рецепт дня')] }), TG), 1);
  assert.equal(pausedInstances(ctx({ paused: [pause('Рецепт дня')] }), IG), 0, 'another resource');
});

test('planPerDay: a resource pause owes nothing; another resource\'s pause and old callers are unchanged', () => {
  assert.deepEqual(planPerDay(ctx({ paused: [pause(null, TG)] }), TG, { min: 2, max: 4 }), { min: 0, max: 4 });
  assert.deepEqual(planPerDay(ctx({ paused: [pause(null, TG)] }), IG, { min: 1, max: 2 }), { min: 1, max: 2 });
  assert.equal(minAfterPauses(ctx({ paused: [pause(null, TG)] }), TG, 3), 0);
  // An old caller passes only rules, pins and the date: it gets what it always got.
  assert.deepEqual(planPerDay({ rules: [], pins: [], planDate: DATE }, TG, { min: 1, max: 4 }), { min: 1, max: 4 });
  assert.deepEqual(planPerDay({ rules: [], pins: [], planDate: DATE, paused: [pause('Рецепт дня')] }, TG, { min: 1, max: 4 }), { min: 1, max: 4 }, 'no series and clocks to count with');
  // With a frequency rule and a pin the pause comes off what is left.
  const freq = rule({ id: 'f', kind: 'frequency', perDayMin: 2, perDayMax: 3 });
  assert.deepEqual(planPerDay(ctx({ rules: [freq], paused: [pause('Рецепт дня')] }), TG, { min: 1, max: 4 }), { min: 1, max: 3 });
});

test('a paused series is not required: a plan without it passes, with the pause lowering the minimum', () => {
  const c = ctx({ paused: [pause('Рецепт дня')] }, [RECIPE]);
  const eff = { ...card, ...planPerDay(c, TG, { min: card.postsPerDayMin, max: card.postsPerDayMax }) };
  assert.equal(eff.min, 0);
  const v = validatePlan({ rationale: 'Серія на паузі, день порожній', slots: [], short_day: undefined }, { ...card, postsPerDayMin: eff.min, postsPerDayMax: eff.max }, DATE, NOW, [], c);
  assert.equal(v.ok, true, errorsOf(v));
});
