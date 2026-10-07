import { z } from 'zod';
import { isQuietHour, zonedToUtc } from '../roles/time';
import { SeriesSourceSchema, type SeriesSource } from '../network/series';
import type { Quiet } from '../time/resource-time';

/**
 * Owner schedule rules (spec 023 FR-001/FR-004): pins, blackouts and frequency overrides of one resource,
 * in that resource's own zone. Pure helpers shared by the plan validators, pin materialisation, the
 * Schedule REST / tab and the chat cards. No I/O here.
 */

export const RULE_KINDS = ['pin', 'blackout', 'frequency'] as const;
export type RuleKind = typeof RULE_KINDS[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ScheduleRule {
  id:          string;
  agentId:     string;
  resourceRef: string;
  kind:        RuleKind;
  /** 0 = Sunday; null = every day. */
  days:        number[] | null;
  atLocal:     string | null;
  untilLocal:  string | null;
  windowMin:   number;
  format:      string | null;
  seriesName:  string | null;
  brief:       string | null;
  source:      SeriesSource | null;
  perDayMin:   number | null;
  perDayMax:   number | null;
  validFrom:   string | null;
  validUntil:  string | null;
  active:      boolean;
  createdBy:   'owner' | 'chat';
  note:        string | null;
  createdAt:   Date;
  updatedAt:   Date;
}

/** A rule as owners and tools write it (snake_case, like the table). */
export const ScheduleRuleInput = z.object({
  resource_ref: z.string().min(3).max(200),
  kind:         z.enum(RULE_KINDS),
  days:         z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable().optional()
    .describe('Дні тижня (0 = неділя); null — щодня'),
  at_local:     z.string().regex(HHMM).nullable().optional().describe('HH:MM у часовому поясі ресурсу (pin; початок blackout)'),
  until_local:  z.string().regex(HHMM).nullable().optional().describe('HH:MM — кінець blackout (може бути наступного дня)'),
  window_min:   z.number().int().min(0).max(120).optional(),
  format:       z.string().min(2).max(30).nullable().optional(),
  series_name:  z.string().min(3).max(80).nullable().optional(),
  brief:        z.string().min(10).max(600).nullable().optional(),
  source:       SeriesSourceSchema.nullable().optional(),
  per_day_min:  z.number().int().min(0).max(24).nullable().optional(),
  per_day_max:  z.number().int().min(0).max(24).nullable().optional(),
  valid_from:   z.string().regex(DATE).nullable().optional(),
  valid_until:  z.string().regex(DATE).nullable().optional(),
  note:         z.string().max(300).nullable().optional(),
});
export type ScheduleRuleInput = z.infer<typeof ScheduleRuleInput>;

/** A partial update (PATCH / chat `update`); `active: false` disables. */
export const ScheduleRulePatch = ScheduleRuleInput.partial().extend({ active: z.boolean().optional() });
export type ScheduleRulePatch = z.infer<typeof ScheduleRulePatch>;

export function rowToRule(r: any): ScheduleRule {
  const day = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  return {
    id: r.id, agentId: r.agent_id, resourceRef: r.resource_ref, kind: r.kind,
    days: Array.isArray(r.days) ? r.days.map(Number) : null,
    atLocal: r.at_local ?? null, untilLocal: r.until_local ?? null, windowMin: Number(r.window_min ?? 20),
    format: r.format ?? null, seriesName: r.series_name ?? null, brief: r.brief ?? null, source: r.source ?? null,
    perDayMin: r.per_day_min == null ? null : Number(r.per_day_min), perDayMax: r.per_day_max == null ? null : Number(r.per_day_max),
    validFrom: day(r.valid_from), validUntil: day(r.valid_until), active: !!r.active, createdBy: r.created_by, note: r.note ?? null,
    createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
  };
}

/** The API shape of a rule (snake_case, like the input). */
export function ruleDto(r: ScheduleRule) {
  return {
    id: r.id, resource_ref: r.resourceRef, kind: r.kind, days: r.days, at_local: r.atLocal, until_local: r.untilLocal,
    window_min: r.windowMin, format: r.format, series_name: r.seriesName, brief: r.brief, source: r.source,
    per_day_min: r.perDayMin, per_day_max: r.perDayMax, valid_from: r.validFrom, valid_until: r.validUntil,
    active: r.active, created_by: r.createdBy, note: r.note, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(),
  };
}
export type ScheduleRuleDto = ReturnType<typeof ruleDto>;

/** Weekday (0 = Sunday) of a calendar date — the same in every zone. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Does an active rule apply on this local date (validity range and weekdays)? */
export function ruleOn(r: Pick<ScheduleRule, 'active' | 'days' | 'validFrom' | 'validUntil'>, date: string): boolean {
  if (!r.active) return false;
  if (r.validFrom && date < r.validFrom) return false;
  if (r.validUntil && date > r.validUntil) return false;
  return !r.days || r.days.includes(weekdayOf(date));
}

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The instant of a pin on a local date (a non-existent DST time moves on, like zonedToUtc). */
export function pinInstant(r: Pick<ScheduleRule, 'atLocal'>, date: string, tz: string): Date {
  return zonedToUtc(date, r.atLocal!, tz);
}

/**
 * Blackout windows that touch a local date, as instants [start, end): the window that starts on the date
 * and one that started the day before and wraps past midnight (e.g. 22:00–06:00).
 */
export function blackoutWindows(rules: ScheduleRule[], ref: string, date: string, tz: string): Array<{ rule: ScheduleRule; start: Date; end: Date }> {
  const out: Array<{ rule: ScheduleRule; start: Date; end: Date }> = [];
  for (const r of rules) {
    if (r.kind !== 'blackout' || r.resourceRef !== ref || !r.atLocal || !r.untilLocal) continue;
    const wraps = minutesOf(r.untilLocal) <= minutesOf(r.atLocal);
    for (const d of [shiftDate(date, -1), date]) {
      if (!ruleOn(r, d)) continue;
      const start = zonedToUtc(d, r.atLocal, tz);
      const end = zonedToUtc(wraps ? shiftDate(d, 1) : d, r.untilLocal, tz);
      out.push({ rule: r, start, end });
    }
  }
  return out;
}

/** The blackout rule an instant falls into on a resource (null = none). */
export function blackoutAt(rules: ScheduleRule[], ref: string, at: Date, tz: string, localDay: string): ScheduleRule | null {
  for (const w of blackoutWindows(rules, ref, localDay, tz)) {
    if (at.getTime() >= w.start.getTime() && at.getTime() < w.end.getTime()) return w.rule;
  }
  return null;
}

/** The frequency override of a resource on a date: the newest applicable rule wins. */
export function frequencyOn(rules: ScheduleRule[], ref: string, date: string): { min: number | null; max: number | null; rule: ScheduleRule } | null {
  const hits = rules.filter((r) => r.kind === 'frequency' && r.resourceRef === ref && ruleOn(r, date))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return hits.length ? { min: hits[0].perDayMin, max: hits[0].perDayMax, rule: hits[0] } : null;
}

/**
 * Posts per day the planner must place itself on a resource: the frequency rule (or the base),
 * minus the materialised pins of the day, which count toward per_day (FR-004).
 */
export function effectivePerDay(base: { min: number; max: number }, freq: { min: number | null; max: number | null } | null, pins: number): { min: number; max: number } {
  const max = freq?.max ?? base.max;
  const min = Math.min(freq?.min ?? base.min, max);
  return { min: Math.max(0, min - pins), max: Math.max(0, max - pins) };
}

/** Rule-level problems (English, shown to the owner) and warnings, given the resource's clock. */
export function ruleProblems(i: ScheduleRuleInput, clock: { quiet: Quiet } | null): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (i.kind === 'pin') {
    if (!i.at_local) errors.push('a pin needs at_local (HH:MM)');
    if (!i.series_name && !i.format) errors.push('a pin needs a format (or a series to take it from)');
    if (!i.series_name && !i.brief) errors.push('a pin needs a brief of at least 10 characters (or a series)');
    if (i.at_local && clock && isQuietHour(Number(i.at_local.slice(0, 2)), clock.quiet.start, clock.quiet.end)) warnings.push('quiet_hours');
  }
  if (i.kind === 'blackout') {
    if (!i.at_local || !i.until_local) errors.push('a blackout needs at_local and until_local (HH:MM)');
    else if (i.at_local === i.until_local) errors.push('a blackout must not start and end at the same time');
  }
  if (i.kind === 'frequency') {
    if (i.per_day_min == null && i.per_day_max == null) errors.push('a frequency rule needs per_day_min and/or per_day_max');
    if (i.per_day_min != null && i.per_day_max != null && i.per_day_min > i.per_day_max) errors.push('per_day_min must not exceed per_day_max');
  }
  if (i.valid_from && i.valid_until && i.valid_from > i.valid_until) errors.push('valid_from must not be after valid_until');
  if (i.days && new Set(i.days).size !== i.days.length) errors.push('days must be unique');
  return { errors, warnings };
}

/** Input → stored columns (defaults applied). */
export function ruleColumns(i: ScheduleRuleInput) {
  return {
    resource_ref: i.resource_ref, kind: i.kind, days: i.days?.length ? [...new Set(i.days)].sort((a, b) => a - b) : null,
    at_local: i.at_local ?? null, until_local: i.kind === 'blackout' ? i.until_local ?? null : null, window_min: i.window_min ?? 20,
    format: i.kind === 'pin' ? i.format ?? null : null, series_name: i.kind === 'pin' ? i.series_name ?? null : null,
    brief: i.kind === 'pin' ? i.brief ?? null : null, source: i.kind === 'pin' ? i.source ?? null : null,
    per_day_min: i.kind === 'frequency' ? i.per_day_min ?? null : null, per_day_max: i.kind === 'frequency' ? i.per_day_max ?? null : null,
    valid_from: i.valid_from ?? null, valid_until: i.valid_until ?? null, note: i.note ?? null,
  };
}

/** A rule back to its input (for PATCH merges and card diffs). */
export function ruleToInput(r: ScheduleRule): ScheduleRuleInput {
  return {
    resource_ref: r.resourceRef, kind: r.kind, days: r.days, at_local: r.atLocal, until_local: r.untilLocal, window_min: r.windowMin,
    format: r.format, series_name: r.seriesName, brief: r.brief, source: r.source, per_day_min: r.perDayMin, per_day_max: r.perDayMax,
    valid_from: r.validFrom, valid_until: r.validUntil, note: r.note,
  };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "every day", "weekdays", "Mon, Thu" … (English; card summaries and the UI). */
export function daysLabel(days: number[] | null | undefined): string {
  if (!days || days.length === 7) return 'every day';
  const s = [...days].sort((a, b) => a - b).join(',');
  if (s === '1,2,3,4,5') return 'weekdays';
  if (s === '0,6') return 'weekends';
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(', ');
}

/** One English line describing a rule ("Pin 19:00 every day · photo · …"). */
export function ruleLabel(i: ScheduleRuleInput): string {
  const range = i.valid_from || i.valid_until ? ` (${i.valid_from ?? '…'} – ${i.valid_until ?? '…'})` : '';
  if (i.kind === 'pin') return `Pin ${i.at_local} ${daysLabel(i.days)}${i.series_name ? ` · series "${i.series_name}"` : ''}${i.format ? ` · ${i.format}` : ''}${range}`;
  if (i.kind === 'blackout') return `Blackout ${i.at_local}–${i.until_local} ${daysLabel(i.days)}${range}`;
  return `Posts per day ${i.per_day_min ?? '…'}–${i.per_day_max ?? '…'} ${daysLabel(i.days)}${range}`;
}
