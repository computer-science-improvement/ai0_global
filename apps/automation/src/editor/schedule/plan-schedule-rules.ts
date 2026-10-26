import { z } from 'zod';
import { isQuietHour, localDate, localTimeLabel, zonedToUtc } from '../roles/time';
import type { Series } from '../network/playbook';
import { instancesOn, parseCadence } from '../network/series';
import type { Quiet } from '../time/resource-time';
import { skipsUk } from '../series-pause/skip-cause';
import { blackoutAt,effectivePerDay, frequencyOn, type ScheduleRule, weekdayOf } from './schedule-rules';

/**
 * Schedule rules in the planners (spec 023 FR-004), as pure functions so the single-channel `validatePlan`
 * and the network `validateNetworkPlan` each call them with one line:
 *   • blackout — a planned slot inside a blackout window of its resource is an error;
 *   • pins — materialised pin slots are fixed: planned slots keep their distance, and pins count toward
 *     per_day (the caller lowers per_day by the pins through `planPerDay`);
 *   • frequency — overrides the playbook per_day / the card's posts per day (`planPerDay`);
 *   • due series — every due active series instance is planned within ±90 min (slot `series`) or listed in
 *     `skipped_series` with a reason; a locked (owner) series cannot be skipped.
 * Errors are Ukrainian lines for the model, like the validators' own.
 */

export const SERIES_WINDOW_MIN = 90;
const LEAD_MIN = 5;

/** Spec 068 FR-004: why a series is skipped for the day. The two material causes are an honest empty day: a locked series may use them, they lower the day's minimum and they count for the dead-series breaker. */
export const SKIP_CAUSES = ['no_material', 'source_unreachable', 'other'] as const;
export type SkipSeriesCause = typeof SKIP_CAUSES[number];
export const isMaterialCause = (c: string | null | undefined): c is 'no_material' | 'source_unreachable' => c === 'no_material' || c === 'source_unreachable';

export const SkippedSeriesInput = z.array(z.object({
  name:   z.string().min(3).max(80),
  reason: z.string().min(10).max(300).describe('Чому серію пропущено в день плану (≥ 10 символів)'),
  cause:  z.enum(SKIP_CAUSES).optional().describe('no_material — для серії немає матеріалу (бібліотека порожня, джерело вичерпане); source_unreachable — джерело не читається; other (за замовчуванням) — інше. Лише з no_material / source_unreachable можна пропустити серію, заблоковану власником; такий пропуск знижує мінімум постів дня і лічиться як мертвий випуск.'),
})).max(20).optional().describe('Серії за розкладом дня плану, які ти свідомо не плануєш (заблокована власником — лише з cause no_material або source_unreachable)');

/**
 * A materialised pin of the plan day (an editor_slots row with schedule_rule_id) or, spec 034 FR-011, a
 * slot a replan keeps (`kept`: running, written, due now, news watch) — both fixed points of the plan.
 */
export interface PinSlot {
  resourceRef: string;
  at:          Date;
  ruleId:      string;
  seriesName:  string | null;
  windowMin:   number;
  kept?:       { status: string; topic: string; live: boolean };
}

/** Everything the schedule checks need about the plan day; built by ScheduleService.planContext. */
export interface PlanScheduleCtx {
  planDate:  string;
  /** The resource of slots without resource_ref (the single planner's channel). */
  defaultRef: string;
  now:       Date;
  /** Resources in scope: zone, quiet hours and the minimum gap between posts there. */
  clocks:    Record<string, { tz: string; quiet: Quiet; gapMin: number }>;
  /** Active rules of the scope's resources. */
  rules:     ScheduleRule[];
  /** Materialised pins of the plan day. */
  pins:      PinSlot[];
  /** The playbook's series (all; inactive ones are ignored). */
  series:    Series[];
  /** The network validator already rejects a series that is not due; the single planner checks it here. */
  checkSlotSeries?: boolean;
  /** Spec 060: series the dead-series breaker paused (not planned, not required) and the last skip reasons per series. */
  paused?:      PausedSeriesCtx[];
  recentSkips?: Array<{ label: string; lines: string[] }>;
}

/** A paused series (or pin, or resource) of the plan's scope, as the planner needs it (spec 060). */
export interface PausedSeriesCtx {
  /** The series name, or null for a pin / a resource pause. */
  name:        string | null;
  /** The resource of a resource-level pause (slots without a series), or null. */
  resourceRef: string | null;
  label:       string;
  streak:      number;
  reason:      string;
}

export interface PlanSlotLike { resource_ref?: string; time: string; series?: string | null; source_hints?: string[] }
export interface PlanLike { slots: PlanSlotLike[]; skipped_series?: Array<{ name: string; reason: string; cause?: SkipSeriesCause }> }

/** A slot's series: its `series` field, else a `series:<name>` source hint. */
export function slotSeries(s: PlanSlotLike): string | null {
  return s.series ?? s.source_hints?.find((h) => h.startsWith('series:'))?.slice('series:'.length) ?? null;
}

export interface DueInstance { series: Series; time: string; at: Date }

/** Due series instances of the day on the scope's resources (resource-local times). */
export function dueInstances(ctx: Pick<PlanScheduleCtx, 'series' | 'clocks' | 'planDate' | 'paused'>): DueInstance[] {
  const wd = weekdayOf(ctx.planDate);
  const out: DueInstance[] = [];
  for (const s of ctx.series) {
    if (s.active === false) continue;
    if (ctx.paused?.some((p) => p.name === s.name)) continue;      // spec 060: a paused series is not due
    const clock = ctx.clocks[s.resource_ref];
    const c = parseCadence(s.cadence);
    if (!clock || !c) continue;
    for (const time of instancesOn(c, wd)) out.push({ series: s, time, at: zonedToUtc(ctx.planDate, time, clock.tz) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The plan's slots with their resource, instant and series (shared by the checks and the due-series matching). */
function planSlots(plan: PlanLike, ctx: PlanScheduleCtx, defaultRef: string) {
  return plan.slots.map((s, i) => {
    const ref = s.resource_ref ?? defaultRef;
    const clock = ctx.clocks[ref];
    return { i, s, ref, clock, at: clock ? zonedToUtc(ctx.planDate, s.time, clock.tz) : null, series: slotSeries(s) };
  });
}
type PlanSlotRow = ReturnType<typeof planSlots>[number];

/** What became of a due series instance in a plan. */
export type DueState = 'late' | 'blackout' | 'pinned' | 'planned' | 'skipped' | 'missing';
export interface DueMatch { due: DueInstance; state: DueState; cause?: SkipSeriesCause; reason?: string }

/**
 * Every due series instance of the day against the plan: too late to plan (a late start) or inside the owner's blackout
 * (not required), covered by a pin or by a planned slot within ±90 min, listed in `skipped_series`, or missing.
 */
function matchDue(plan: PlanLike, ctx: PlanScheduleCtx, slots: PlanSlotRow[]): DueMatch[] {
  const skipped = new Map((plan.skipped_series ?? []).map((k) => [k.name, k]));
  const used = new Set<number>();
  const usedPins = new Set<string>();
  const out: DueMatch[] = [];
  for (const d of dueInstances(ctx)) {
    const clock = ctx.clocks[d.series.resource_ref];
    const win = SERIES_WINDOW_MIN * 60_000;
    // Too late to plan today (late start) or inside the owner's blackout: not required.
    if (d.at.getTime() + win < ctx.now.getTime() + LEAD_MIN * 60_000) { out.push({ due: d, state: 'late' }); continue; }
    if (clock && blackoutAt(ctx.rules, d.series.resource_ref, d.at, clock.tz, ctx.planDate)) { out.push({ due: d, state: 'blackout' }); continue; }
    const pin = ctx.pins.find((p) => p.seriesName === d.series.name && p.resourceRef === d.series.resource_ref
      && !usedPins.has(`${p.ruleId}`) && Math.abs(p.at.getTime() - d.at.getTime()) <= win);
    if (pin) { usedPins.add(pin.ruleId); out.push({ due: d, state: 'pinned' }); continue; }
    const hit = slots.find((x) => !used.has(x.i) && x.series === d.series.name && x.ref === d.series.resource_ref
      && x.at && Math.abs(x.at.getTime() - d.at.getTime()) <= win);
    if (hit) { used.add(hit.i); out.push({ due: d, state: 'planned' }); continue; }
    const k = skipped.get(d.series.name);
    out.push(k ? { due: d, state: 'skipped', cause: k.cause ?? 'other', reason: k.reason } : { due: d, state: 'missing' });
  }
  return out;
}

export type MaterialSkip = DueInstance & { cause: 'no_material' | 'source_unreachable'; reason: string };

/**
 * Spec 068 FR-004: the due instances the planner declared empty with a material cause (no material, source unreachable).
 * The day's minimum loses them, and each leaves a placeholder slot for the dead-series breaker.
 */
export function materialSkips(plan: PlanLike, ctx: PlanScheduleCtx, defaultRef: string): MaterialSkip[] {
  const out: MaterialSkip[] = [];
  for (const m of matchDue(plan, ctx, planSlots(plan, ctx, defaultRef))) {
    if (m.state === 'skipped' && isMaterialCause(m.cause)) out.push({ ...m.due, cause: m.cause, reason: m.reason ?? '' });
  }
  return out;
}

/** The way out a planner is told when a day cannot be filled because there is nothing to post from. */
export const EMPTY_DAY_WAY_OUT = 'якщо матеріалу немає — skipped_series з cause: no_material (для серії) або short_day (для всього дня)';

/** The schedule-rule errors of a plan (empty = fine). `defaultRef` is the resource of slots without one. */
export function planScheduleErrors(plan: PlanLike, ctx: PlanScheduleCtx, defaultRef: string): string[] {
  const errors: string[] = [];
  const slots = planSlots(plan, ctx, defaultRef);
  const label = (x: typeof slots[number]) => `слот ${x.i + 1} (${x.s.resource_ref ? `${x.ref} ` : ''}${x.s.time})`;

  // Blackouts and pins.
  for (const x of slots) {
    if (!x.clock || !x.at) continue;
    const b = blackoutAt(ctx.rules, x.ref, x.at, x.clock.tz, ctx.planDate);
    if (b) errors.push(`${label(x)}: заборонене вікно власника ${b.atLocal}–${b.untilLocal} (${x.clock.tz}) — обери інший час`);
    for (const p of ctx.pins) {
      if (p.resourceRef !== x.ref) continue;
      const gap = Math.max(p.windowMin, x.clock.gapMin);
      if (Math.abs(p.at.getTime() - x.at.getTime()) < gap * 60_000) {
        errors.push(p.kept
          ? `${label(x)}: занадто близько до поста, що вже є в плані о ${localTimeLabel(p.at, x.clock.tz)} (${p.kept.status}; мінімум ${gap} хв)`
          : `${label(x)}: занадто близько до закріпленого поста власника о ${localTimeLabel(p.at, x.clock.tz)} (мінімум ${gap} хв)`);
      }
    }
  }

  // Spec 060: a paused series (or a resource whose plain slots are paused) is not planned.
  for (const x of slots) {
    const p = ctx.paused?.find((y) => (x.series ? y.name === x.series : y.resourceRef === x.ref));
    if (p) errors.push(`${label(x)}: ${p.name ? `серія «${p.name}»` : `планування ${p.resourceRef}`} на паузі (${p.streak} ${skipsUk(p.streak)} поспіль${p.reason ? `: ${p.reason}` : ''}) — не плануй її, обери іншу серію чи формат`);
  }

  // Due series: planned within ±90 min, covered by a pin, or skipped with a reason.
  const due = dueInstances(ctx);
  const dueNames = new Set(due.map((d) => d.series.name));
  if (ctx.checkSlotSeries) {
    for (const x of slots) {
      if (!x.series) continue;
      const s = ctx.series.find((y) => y.name === x.series);
      if (!dueNames.has(x.series)) errors.push(`${label(x)}: серія «${x.series}» ${ctx.planDate} не за розкладом або неактивна`);
      else if (s && s.resource_ref !== x.ref) errors.push(`${label(x)}: серія «${x.series}» належить ресурсу ${s.resource_ref}`);
    }
  }
  // Spec 068 FR-004: a locked series may be skipped only because there is nothing to post from (a material cause).
  for (const k of plan.skipped_series ?? []) {
    const s = ctx.series.find((y) => y.name === k.name);
    if (s?.locked && dueNames.has(k.name) && !isMaterialCause(k.cause)) {
      errors.push(`серію «${k.name}» заблокував власник — її не можна пропустити без причини: якщо для неї немає матеріалу, постав у skipped_series cause: no_material (або source_unreachable, якщо джерело не читається), інакше заплануй її`);
    }
  }
  for (const m of matchDue(plan, ctx, slots)) {
    const d = m.due, clock = ctx.clocks[d.series.resource_ref];
    if (m.state === 'skipped') {
      if (!d.series.locked && (m.reason ?? '').trim().length < 10) errors.push(`серія «${d.series.name}»: причина пропуску ≥ 10 символів`);
    } else if (m.state === 'missing') {
      errors.push(`серія «${d.series.name}» (${d.series.resource_ref}) за розкладом о ${d.time}${clock ? ` (${clock.tz})` : ''}: заплануй слот із series="${d.series.name}" у межах ±${SERIES_WINDOW_MIN} хв або додай її в skipped_series з причиною${d.series.locked ? ' (серію заблокував власник — пропустити можна лише з cause: no_material або source_unreachable, коли для неї немає матеріалу)' : ' (немає матеріалу — cause: no_material)'}`);
    }
  }
  return errors;
}

/** What the pause-aware minimum needs of a plan context; series and clocks are optional so old callers keep working. */
export type PauseCtx = Pick<PlanScheduleCtx, 'planDate' | 'paused'> & Partial<Pick<PlanScheduleCtx, 'series' | 'clocks'>>;

/** Instances of the series the dead-series breaker paused, on one resource and day (a paused series is not due, so they are counted apart). */
export function pausedInstances(ctx: PauseCtx, ref: string): number {
  const { paused, series, clocks } = ctx;
  if (!paused?.length || !series || !clocks) return 0;
  const wd = weekdayOf(ctx.planDate);
  let n = 0;
  for (const s of series) {
    if (s.active === false || s.resource_ref !== ref || !paused.some((p) => p.name === s.name)) continue;
    const c = parseCadence(s.cadence);
    if (clocks[s.resource_ref] && c) n += instancesOn(c, wd).length;
  }
  return n;
}

/** Is the resource's plain-slot planning paused (a `resource:` pause)? Then nothing is owed there. */
export const resourcePaused = (ctx: Pick<PlanScheduleCtx, 'paused'>, ref: string): boolean =>
  !!ctx.paused?.some((p) => !p.name && p.resourceRef === ref);

/** Spec 068 FR-005: the day's minimum after the pauses: it loses the paused series' instances, and a resource pause sets it to 0. */
export function minAfterPauses(ctx: PauseCtx, ref: string, min: number): number {
  if (resourcePaused(ctx, ref)) return 0;
  return Math.max(0, min - pausedInstances(ctx, ref));
}

/**
 * Per-day bounds the planner places itself on one resource: frequency rule, minus the day's pins and (spec 068 FR-005, when the
 * context carries the pauses, series and clocks) minus the instances of paused series; a resource pause owes nothing.
 */
export function planPerDay(
  ctx: Pick<PlanScheduleCtx, 'rules' | 'pins' | 'planDate'> & Partial<Pick<PlanScheduleCtx, 'series' | 'clocks' | 'paused'>>,
  ref: string, base: { min: number; max: number },
): { min: number; max: number } {
  const pd = effectivePerDay(base, frequencyOn(ctx.rules, ref, ctx.planDate), ctx.pins.filter((p) => p.resourceRef === ref).length);
  return ctx.paused?.length ? { min: minAfterPauses(ctx, ref, pd.min), max: pd.max } : pd;
}

/** The prompt lines for the planner about the day's schedule (pins, blackouts, frequency, due series). */
export function scheduleBlock(ctx: PlanScheduleCtx, withPauses = true): string | null {
  const lines: string[] = [];
  for (const p of ctx.pins) {
    const clock = ctx.clocks[p.resourceRef];
    if (p.kept) {
      lines.push(`- уже в плані ${p.resourceRef} о ${clock ? localTimeLabel(p.at, clock.tz) : p.at.toISOString()} (${p.kept.status}${p.kept.live ? ', live' : ''}): «${p.kept.topic}»${p.seriesName ? ` (серія «${p.seriesName}»)` : ''} — залишається, рахується в кількість постів дня; не повторюй тему й тримай інтервал`);
      continue;
    }
    lines.push(`- закріплений пост власника ${p.resourceRef} о ${clock ? localTimeLabel(p.at, clock.tz) : p.at.toISOString()}${p.seriesName ? ` (серія «${p.seriesName}»)` : ''} — уже в плані, не дублюй і тримай інтервал`);
  }
  for (const r of ctx.rules) {
    if (r.kind === 'blackout') {
      const clock = ctx.clocks[r.resourceRef];
      if (clock && blackoutAt([r], r.resourceRef, zonedToUtc(ctx.planDate, r.atLocal!, clock.tz), clock.tz, ctx.planDate)) {
        lines.push(`- заборонене вікно ${r.resourceRef}: ${r.atLocal}–${r.untilLocal} — жодних постів`);
      }
    }
  }
  for (const ref of Object.keys(ctx.clocks)) {
    const f = frequencyOn(ctx.rules, ref, ctx.planDate);
    if (f) lines.push(`- частота ${ref} ${ctx.planDate}: ${f.min ?? '…'}–${f.max ?? '…'} постів (правило власника, замість per_day)`);
  }
  for (const d of dueInstances(ctx)) {
    lines.push(`- серія «${d.series.name}» ${d.series.resource_ref} о ${d.time} (±${SERIES_WINDOW_MIN} хв, format ${d.series.format})${d.series.locked ? ' — заблокована власником, обовʼязкова (немає матеріалу — skipped_series з cause: no_material)' : ' — або skipped_series з причиною (немає матеріалу — cause: no_material)'}`);
  }
  for (const p of withPauses ? ctx.paused ?? [] : []) {
    lines.push(`- ${p.name ? `серія «${p.name}»` : p.resourceRef ? `планування ${p.resourceRef}` : p.label} НА ПАУЗІ: ${p.streak} ${skipsUk(p.streak)} поспіль${p.reason ? ` (${p.reason})` : ''} — не плануй слотів цієї серії, код їх відхилить; обери іншу серію чи формат`);
  }
  for (const r of withPauses ? ctx.recentSkips ?? [] : []) {
    lines.push(`- останні пропуски «${r.label}»: ${r.lines.map((l, i) => `${i + 1}) ${l}`).join('; ')} — якщо матеріалу для слота, схоже, немає, не плануй його: обери іншу серію чи формат`);
  }
  return lines.length ? `Розклад власника на ${ctx.planDate} (код перевіряє):\n${lines.join('\n')}` : null;
}

/** Is a local time in quiet hours on a resource (used for owner warnings). */
export function inQuiet(time: string, quiet: Quiet): boolean {
  return isQuietHour(Number(time.slice(0, 2)), quiet.start, quiet.end);
}

/** The resource-local date of an instant (re-exported for callers that only import this module). */
export const localDayOf = (at: Date, tz: string) => localDate(at, tz);
