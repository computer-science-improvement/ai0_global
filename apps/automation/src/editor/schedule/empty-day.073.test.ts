// Spec 073 T7 (FR-007, A42): a due series the planner skipped for a NON-material reason leaves a `planner_skipped: <reason>`
// placeholder too (a material cause keeps `planner_<cause>`). The placeholder does not lower the day's minimum, the breaker
// ignores it, the skip group is `other`, and `EMPTY_DAY_ERROR_RE` (spliced into Postgres `~`, so no `\b`) matches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../roles/plan-rules';
import { validateNetworkPlan } from '../network/network-plan';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import type { NetworkCtx } from '../network/network-context';
import { makeCard } from '../post/testing/fixtures';
import type { PlanScheduleCtx } from './plan-schedule-rules';
import { nonMaterialSkips, materialSkips } from './plan-schedule-rules';
import { EMPTY_DAY_ERROR_RE, emptyDayError, skippedSeriesPlaceholders } from './empty-day';
import type { IdeaRow } from '../network/network.repository';
import { classifyClose } from '../series-pause/skip-cause';
import { skipGroupOf } from '../silent/skip-reasons';

const CH = '@food';
const TG = `telegram:${CH}`;
const IG = 'instagram:ig1';
const DATE = '2026-10-07';                          // Wednesday
const NOW = new Date('2026-10-07T04:00:00Z');       // 07:00 Kyiv (UTC+3)
const card = makeCard({ channelKey: CH, postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, formats: { photo: 1, text: 1 } });

const TIP = { name: 'Порада', cadence: 'weekly:wed@12:00', resource_ref: TG, format: 'text', brief: 'Коротка кухонна порада дня' };

const playbook = (series: unknown[] = []): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } },
    { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 1, max: 2 } },
  ],
  series,
});

function ctx(series: unknown[] = [TIP]): PlanScheduleCtx {
  return {
    planDate: DATE, defaultRef: TG, now: NOW,
    clocks: { [TG]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 }, gapMin: 60 }, [IG]: { tz: 'America/New_York', quiet: { start: 22, end: 7 }, gapMin: 60 } },
    rules: [], pins: [], series: playbook(series).series, checkSlotSeries: true,
  };
}
const slot = (time: string, extra: Record<string, unknown> = {}) => ({ time, format: 'photo', topic: 'Тема поста про їжу', source_hints: [] as string[], is_experiment: false, ...extra });
const errorsOf = (v: { ok: boolean }) => (v.ok ? '' : (v as any).errors.join('\n'));
const REASON = 'Порада на сьогодні вже була в іншій серії';

test('single plan: a series skipped without a material cause leaves a planner_skipped placeholder at its time and takes nothing off the minimum', () => {
  const c = ctx();
  const plain = validatePlan({ rationale: 'Пораду пропускаю, усе інше є', slots: [], skipped_series: [{ name: 'Порада', reason: REASON }] }, card, DATE, NOW, [], c);
  assert.equal(plain.ok, false, 'the minimum is still 1: a non-material skip is not an honest empty day');
  assert.match(errorsOf(plain), /кількість постів/);

  const v = validatePlan({ rationale: 'Пораду пропускаю, пост дня інший', slots: [slot('19:00')], skipped_series: [{ name: 'Порада', reason: REASON, cause: 'other' }] }, card, DATE, NOW, [], c);
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  assert.equal(v.slots.length, 1);
  assert.equal(v.empty.length, 1);
  assert.deepEqual(
    { at: v.empty[0].scheduledAt.toISOString(), series: v.empty[0].seriesName, hints: v.empty[0].sourceHints, format: v.empty[0].format, topic: v.empty[0].topic, ref: v.empty[0].resourceRef, error: v.empty[0].error },
    { at: '2026-10-07T09:00:00.000Z', series: 'Порада', hints: ['series:Порада'], format: 'text', topic: 'Порожній випуск: Порада', ref: null, error: `planner_skipped: ${REASON}` });

  // No cause is `other` too.
  const none = validatePlan({ rationale: 'Пораду пропускаю, пост дня інший', slots: [slot('19:00')], skipped_series: [{ name: 'Порада', reason: REASON }] }, card, DATE, NOW, [], c);
  assert.equal(none.ok, true, errorsOf(none));
  if (none.ok) assert.equal(none.empty[0].error, `planner_skipped: ${REASON}`);
});

test('a material cause keeps planner_<cause>; both kinds can be in one plan; an instance that is not required leaves nothing', () => {
  const series = [TIP, { ...TIP, name: 'Кухонний лайфхак', cadence: 'weekly:wed@15:00' }];
  const c = ctx(series);
  const v = validatePlan({
    rationale: 'Одну пропускаю без матеріалу, іншу з іншої причини', slots: [slot('19:00')],
    skipped_series: [{ name: 'Порада', reason: REASON, cause: 'no_material' }, { name: 'Кухонний лайфхак', reason: 'Лайфхак цього тижня вже вийшов у вівторок' }],
  }, card, DATE, NOW, [], c);
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  assert.deepEqual(v.empty.map((e) => [e.seriesName, e.error.split(':')[0]]).sort(), [['Кухонний лайфхак', 'planner_skipped'], ['Порада', 'planner_no_material']]);

  // Only the material one is in materialSkips (the minimum); only the other is in nonMaterialSkips.
  const plan = { slots: [slot('19:00')], skipped_series: [{ name: 'Порада', reason: REASON, cause: 'no_material' as const }, { name: 'Кухонний лайфхак', reason: 'Лайфхак вже вийшов у вівторок' }] };
  assert.deepEqual(materialSkips(plan, c, TG).map((m) => m.series.name), ['Порада']);
  assert.deepEqual(nonMaterialSkips(plan, c, TG).map((m) => [m.series.name, m.cause]), [['Кухонний лайфхак', 'other']]);

  // A late start: the 12:00 tip has passed, so it is not required and not recorded.
  const late = new Date('2026-10-07T15:00:00Z');
  const lc = { ...ctx(), now: late };
  assert.deepEqual(skippedSeriesPlaceholders({ slots: [slot('21:00')], skipped_series: [{ name: 'Порада', reason: REASON }] }, lc, TG), []);
});

test('network plan: a non-material skip of a series on a resource leaves its placeholder with the resource_ref; the resource keeps its minimum', () => {
  const RES = [{ ref: TG, platform: 'telegram' as const }, { ref: IG, platform: 'instagram' as const, tz: 'America/New_York' }];
  const I1 = '00000000-0000-4000-8000-000000000001';
  const net: NetworkCtx = {
    orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: CH, groupId: 'g1', groupName: 'Кухня', mode: 'independent',
    resources: RES, playbook: playbook([TIP]), playbookVersion: 1, telegramFormats: ['text', 'photo'],
  };
  const idea: IdeaRow = {
    id: I1, agentId: 'o1', title: 'Ідея I1', angle: null, sources: ['https://x'], variants: [{ resource_ref: TG, format: 'text' }],
    why: null, evidence: null, origin: 'orchestrator', originRef: null, expiresAt: new Date(), status: 'accepted', revisions: 0, review: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const tgPost = { resource_ref: TG, time: '19:00', format: 'text', topic: 'Порада про ніж', idea_id: I1, source_hints: [] as string[], reason: 'Ядро мережі: коротка порада' };
  const igSkip = { idea_id: I1, resource_ref: IG, reason: 'Профіль IG — візуал, тут лише текст', reason_code: 'format_unfit' as const };
  const opts = { net, card, planDate: DATE, weekday: 3, now: NOW, ideas: new Map([[I1, idea]]), reservedAt: [] as Date[], schedule: { ...ctx(), checkSlotSeries: false } };
  const plan = {
    rationale: 'Пораду пропускаю, пост дня інший', slots: [tgPost], skips: [igSkip],
    short_days: [{ resource_ref: IG, cause: 'no_material' as const, reason: 'Для Instagram сьогодні немає з чого писати' }],
    skipped_series: [{ name: 'Порада', reason: REASON }],
  };
  const v = validateNetworkPlan(plan, opts as any);
  assert.equal(v.ok, true, errorsOf(v));
  if (!v.ok) return;
  const byKind = v.empty.map((e) => [e.seriesName, e.resourceRef, e.error.split(':')[0]]);
  assert.deepEqual(byKind.sort(), [[null, IG, 'planner_no_material'], ['Порада', null, 'planner_skipped']].sort());
});

test('classification: the breaker ignores planner_skipped; its skip group is other; the SQL pattern matches it and the other empty-day codes', () => {
  const closed = { status: 'skipped', error: emptyDayError('skipped', REASON), criticVerdict: null } as any;
  assert.deepEqual(classifyClose({ ...closed, id: 's', resourceRef: TG, channelKey: CH, seriesName: 'Порада', scheduleRuleId: null, topic: 't', scheduledAt: NOW, updatedAt: NOW }), { k: 'ignore' });
  assert.equal(skipGroupOf(closed.error), 'other');
  assert.equal(emptyDayError('skipped', `  ${REASON}  `), `planner_skipped: ${REASON}`);

  // The regex is for Postgres `~`: no `\b`, and it is anchored.
  assert.ok(!EMPTY_DAY_ERROR_RE.includes('\\b'));
  const re = new RegExp(EMPTY_DAY_ERROR_RE);
  for (const e of ['planner_skipped: x', 'planner_no_material: x', 'planner_source_unreachable: x', 'series_format_unavailable: x', 'series_in_quiet_hours: x']) assert.ok(re.test(e), e);
  for (const e of ['superseded by a new plan', 'xplanner_skipped: x', 'planner_other: x', 'skipped by agent: planner_skipped']) assert.ok(!re.test(e), e);
});
