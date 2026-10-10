import { z } from 'zod';
import { isQuietHour, localDate, localTimeLabel, zonedToUtc } from '../roles/time';
import type { Series } from '../network/playbook';
import { instancesOn, parseCadence } from '../network/series';
import type { Quiet } from '../time/resource-time';
import { blackoutAt, effectivePerDay, frequencyOn, type ScheduleRule, weekdayOf } from './schedule-rules';

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

export const SkippedSeriesInput = z.array(z.object({
  name:   z.string().min(3).max(80),
  reason: z.string().min(10).max(300).describe('Чому серія сьогодні пропущена (≥ 10 символів)'),
})).max(20).optional().describe('Серії за розкладом, які ти свідомо не плануєш сьогодні (заблоковані власником — не можна)');

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
}

export interface PlanSlotLike { resource_ref?: string; time: string; series?: string | null; source_hints?: string[] }
export interface PlanLike { slots: PlanSlotLike[]; skipped_series?: Array<{ name: string; reason: string }> }

/** A slot's series: its `series` field, else a `series:<name>` source hint. */
export function slotSeries(s: PlanSlotLike): string | null {
  return s.series ?? s.source_hints?.find((h) => h.startsWith('series:'))?.slice('series:'.length) ?? null;
}

export interface DueInstance { series: Series; time: string; at: Date }

/** Due series instances of the day on the scope's resources (resource-local times). */
export function dueInstances(ctx: Pick<PlanScheduleCtx, 'series' | 'clocks' | 'planDate'>): DueInstance[] {
  const wd = weekdayOf(ctx.planDate);
  const out: DueInstance[] = [];
  for (const s of ctx.series) {
    if (s.active === false) continue;
    const clock = ctx.clocks[s.resource_ref];
    const c = parseCadence(s.cadence);
    if (!clock || !c) continue;
    for (const time of instancesOn(c, wd)) out.push({ series: s, time, at: zonedToUtc(ctx.planDate, time, clock.tz) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The schedule-rule errors of a plan (empty = fine). `defaultRef` is the resource of slots without one. */
export function planScheduleErrors(plan: PlanLike, ctx: PlanScheduleCtx, defaultRef: string): string[] {
  const errors: string[] = [];
  const slots = plan.slots.map((s, i) => {
    const ref = s.resource_ref ?? defaultRef;
    const clock = ctx.clocks[ref];
    return { i, s, ref, clock, at: clock ? zonedToUtc(ctx.planDate, s.time, clock.tz) : null, series: slotSeries(s) };
  });
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

  // Due series: planned within ±90 min, covered by a pin, or skipped with a reason.
  const due = dueInstances(ctx);
  const dueNames = new Set(due.map((d) => d.series.name));
  if (ctx.checkSlotSeries) {
    for (const x of slots) {
      if (!x.series) continue;
      const s = ctx.series.find((y) => y.name === x.series);
      if (!dueNames.has(x.series)) errors.push(`${label(x)}: серія «${x.series}» сьогодні не за розкладом або неактивна`);
      else if (s && s.resource_ref !== x.ref) errors.push(`${label(x)}: серія «${x.series}» належить ресурсу ${s.resource_ref}`);
    }
  }
  const skipped = new Map((plan.skipped_series ?? []).map((k) => [k.name, k.reason]));
  for (const [name] of skipped) {
    const s = ctx.series.find((y) => y.name === name);
    if (s?.locked && dueNames.has(name)) errors.push(`серію «${name}» заблокував власник — її не можна пропустити, заплануй її`);
  }
  const used = new Set<number>();
  const usedPins = new Set<string>();
  for (const d of due) {
    const clock = ctx.clocks[d.series.resource_ref];
    const win = SERIES_WINDOW_MIN * 60_000;
    // Too late to plan today (late start) or inside the owner's blackout: not required.
    if (d.at.getTime() + win < ctx.now.getTime() + LEAD_MIN * 60_000) continue;
    if (clock && blackoutAt(ctx.rules, d.series.resource_ref, d.at, clock.tz, ctx.planDate)) continue;
    const pin = ctx.pins.find((p) => p.seriesName === d.series.name && p.resourceRef === d.series.resource_ref
      && !usedPins.has(`${p.ruleId}`) && Math.abs(p.at.getTime() - d.at.getTime()) <= win);
    if (pin) { usedPins.add(pin.ruleId); continue; }
    const hit = slots.find((x) => !used.has(x.i) && x.series === d.series.name && x.ref === d.series.resource_ref
      && x.at && Math.abs(x.at.getTime() - d.at.getTime()) <= win);
    if (hit) { used.add(hit.i); continue; }
    if (skipped.has(d.series.name)) {
      if (!d.series.locked && (skipped.get(d.series.name) ?? '').trim().length < 10) errors.push(`серія «${d.series.name}»: причина пропуску ≥ 10 символів`);
      continue;
    }
    errors.push(`серія «${d.series.name}» (${d.series.resource_ref}) за розкладом о ${d.time}${clock ? ` (${clock.tz})` : ''}: заплануй слот із series="${d.series.name}" у межах ±${SERIES_WINDOW_MIN} хв або додай її в skipped_series з причиною${d.series.locked ? ' (серію заблокував власник — пропускати не можна)' : ''}`);
  }
  return errors;
}

/** Per-day bounds the planner places itself on one resource: frequency rule, minus the day's pins. */
export function planPerDay(ctx: Pick<PlanScheduleCtx, 'rules' | 'pins' | 'planDate'>, ref: string, base: { min: number; max: number }): { min: number; max: number } {
  return effectivePerDay(base, frequencyOn(ctx.rules, ref, ctx.planDate), ctx.pins.filter((p) => p.resourceRef === ref).length);
}

/** The prompt lines for the planner about the day's schedule (pins, blackouts, frequency, due series). */
export function scheduleBlock(ctx: PlanScheduleCtx): string | null {
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
    if (f) lines.push(`- частота ${ref} сьогодні: ${f.min ?? '…'}–${f.max ?? '…'} постів (правило власника, замість per_day)`);
  }
  for (const d of dueInstances(ctx)) {
    lines.push(`- серія «${d.series.name}» ${d.series.resource_ref} о ${d.time} (±${SERIES_WINDOW_MIN} хв, format ${d.series.format})${d.series.locked ? ' — заблокована власником, обовʼязкова' : ' — або skipped_series з причиною'}`);
  }
  return lines.length ? `Розклад власника на ${ctx.planDate} (код перевіряє):\n${lines.join('\n')}` : null;
}

/** Is a local time in quiet hours on a resource (used for owner warnings). */
export function inQuiet(time: string, quiet: Quiet): boolean {
  return isQuietHour(Number(time.slice(0, 2)), quiet.start, quiet.end);
}

/** The resource-local date of an instant (re-exported for callers that only import this module). */
export const localDayOf = (at: Date, tz: string) => localDate(at, tz);
