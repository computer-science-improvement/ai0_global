import { z } from 'zod';
import { zonedToUtc } from '../roles/time';
import { shiftDate } from './schedule-rules';
import { materialSkips, nonMaterialSkips, type PlanLike, type PlanScheduleCtx } from './plan-schedule-rules';

/**
 * Spec 068 FR-004: an honest empty day. A planner with nothing to post from says so (a series skipped with a material
 * cause, or a whole `short_day`), instead of planning slots that are doomed to skip. The code records what it said as
 * placeholder slots — `kind 'content'`, `status 'skipped'`, the error `planner_<cause>: <reason>` — written in the plan's
 * own transaction. They are ordinary closed slots: the dead-series breaker counts them (spec 060), `dark_day` and
 * `series_missed` show the planner's reason, and the day's minimum loses them. No new table and no new note kind.
 */
export const SHORT_DAY_CAUSES = ['no_material', 'source_unreachable'] as const;
export type ShortDayCause = typeof SHORT_DAY_CAUSES[number];

const CAUSE_DESCRIBE = 'no_material — для ресурсу немає матеріалу (бібліотека порожня, джерела вичерпані); source_unreachable — джерела не читаються';

export const ShortDayInput = z.object({
  cause:  z.enum(SHORT_DAY_CAUSES).describe(CAUSE_DESCRIBE),
  reason: z.string().min(20).max(300).describe('Чому сьогодні немає з чого писати (≥ 20 символів): що перевірено — бібліотека, джерела картки, пул ідей'),
}).optional().describe('Чесний порожній день: з чого писати немає, тож мінімум постів дня знижується до 0 (максимум лишається). Лише коли справді перевірив матеріал; код записує це як пропущений слот і лічить у лічильник мертвих серій.');

export const ShortDaysInput = z.array(z.object({
  resource_ref: z.string().min(3).max(200),
  cause:        z.enum(SHORT_DAY_CAUSES).describe(CAUSE_DESCRIBE),
  reason:       z.string().min(20).max(300).describe('Чому на цьому ресурсі сьогодні немає з чого писати (≥ 20 символів)'),
})).max(20).optional().describe('Чесний порожній день по ресурсах: мінімум постів дня для цього ресурсу — 0 (максимум лишається). Лише коли справді перевірив матеріал.');

/** A placeholder slot of an honest empty day, as the plan transaction stores it. */
export interface EmptyDaySlot {
  scheduledAt: Date;
  /** null = the anchor channel itself (stored without `resource_ref`). */
  resourceRef: string | null;
  format:      string;
  topic:       string;
  sourceHints: string[];
  seriesName:  string | null;
  /** `planner_no_material: <reason>` or `planner_source_unreachable: <reason>`. */
  error:       string;
  /** A whole short day: the plan day's window on its resource — a second declaration inside it is the same close (a replan). */
  day?:        { from: Date; to: Date };
}

/**
 * The SQL regex (Postgres `~`) that recognises a placeholder by its error; no quotes inside, it is spliced into queries.
 * Spec 073 (A42): it also names the placeholders of a non-material skip (`planner_skipped`) and of the skeleton check
 * (`series_format_unavailable`, `series_in_quiet_hours`). It has NO `\b`: in Postgres `~` a `\b` is a backspace, not a word edge.
 */
export const EMPTY_DAY_ERROR_RE = '^(planner_(no_material|source_unreachable|skipped)|series_format_unavailable|series_in_quiet_hours)';

/** `planner_<cause>: <reason>`; `skipped` is the spec 073 cause of a series the planner skipped for no material reason. */
export const emptyDayError = (cause: ShortDayCause | 'skipped', reason: string): string => `planner_${cause}: ${reason.trim()}`.slice(0, 500);

/**
 * One placeholder per due instance of a series the planner skipped, at the instance's time: `planner_<cause>: <reason>` for a
 * material cause, `planner_skipped: <reason>` for any other (spec 073 FR-007) — so a series that stops leaves a trace.
 */
export function skippedSeriesPlaceholders(plan: PlanLike, ctx: PlanScheduleCtx, anchorRef: string): EmptyDaySlot[] {
  const slot = (m: { at: Date; series: { resource_ref: string; format: string; name: string } }, error: string): EmptyDaySlot => ({
    scheduledAt: m.at, resourceRef: m.series.resource_ref === anchorRef ? null : m.series.resource_ref,
    format: m.series.format, topic: `Порожній випуск: ${m.series.name}`.slice(0, 300), sourceHints: [`series:${m.series.name}`],
    seriesName: m.series.name, error,
  });
  return [
    ...materialSkips(plan, ctx, ctx.defaultRef).map((m) => slot(m, emptyDayError(m.cause, m.reason))),
    ...nonMaterialSkips(plan, ctx, ctx.defaultRef).map((m) => slot(m, emptyDayError('skipped', m.reason))),
  ];
}

/**
 * Spec 073 A54: one config placeholder per series instance the skeleton check excluded (`ctx.excluded`), at the instance's time, with
 * the error `<code>: <detail>` (`series_format_unavailable` or `series_in_quiet_hours`; both are in `EMPTY_DAY_ERROR_RE`). Both
 * validators add them to `empty`, so the owner sees the series that cannot go out (`series_missed`) and the breaker ignores it (config).
 */
export function excludedPlaceholders(ctx: Pick<PlanScheduleCtx, 'excluded' | 'series'>, anchorRef: string): EmptyDaySlot[] {
  return (ctx.excluded ?? []).map((e) => ({
    scheduledAt: e.at, resourceRef: e.resourceRef === anchorRef ? null : e.resourceRef,
    format: ctx.series.find((s) => s.name === e.series && s.resource_ref === e.resourceRef)?.format ?? 'text',
    topic: `Порожній випуск: ${e.series}`.slice(0, 300), sourceHints: [`series:${e.series}`], seriesName: e.series,
    error: `${e.code}: ${e.detail}`.slice(0, 500),
  }));
}

/** The placeholder of a `short_day`: one per resource per day, at the later of now and the start of the plan day there. */
export function shortDayPlaceholder(o: {
  resourceRef: string | null; tz: string; planDate: string; now: Date; cause: ShortDayCause; reason: string;
}): EmptyDaySlot {
  const from = zonedToUtc(o.planDate, '00:00', o.tz);
  const to = zonedToUtc(shiftDate(o.planDate, 1), '00:00', o.tz);
  return {
    scheduledAt: new Date(Math.max(o.now.getTime(), from.getTime())), resourceRef: o.resourceRef, format: 'text',
    topic: `Порожній день: ${o.reason.trim()}`.slice(0, 200), sourceHints: [], seriesName: null, error: emptyDayError(o.cause, o.reason),
    day: { from, to },
  };
}
