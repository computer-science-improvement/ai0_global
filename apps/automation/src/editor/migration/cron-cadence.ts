import { formatCadence, MAX_SERIES_TIMES } from '../network/series';
import { isQuietHour, tzOffsetMs } from '../roles/time';

/**
 * Strategy cron → series cadence (spec 023 FR-011), deterministic and without an LLM.
 *
 * Supported: a fixed minute or a minute list, an hour list / range / step, a day-of-week list / range or `*`,
 * with day-of-month and month `*`. Times move from the scheduler's zone (SCHEDULER_TZ, else the process zone)
 * to the resource zone at the current offsets; quiet-hour times are dropped. More than 6 times a day or a minute
 * step is a frequency hint (no series). Retry crons of the digests (`*\/10 19-20`) collapse to their first time.
 */

export interface CronInput {
  schedule: string;
  /** Digest strategies poll every few minutes inside a window until they post once: the first time is the slot. */
  retryLoop?: boolean;
  /** The zone the scheduler evaluates the cron in. */
  cronTz:   string;
  /** The resource's zone (series times are local to it). */
  targetTz: string;
  quiet:    { start: number; end: number };
  now:      Date;
}

export type CronMapping =
  | { kind: 'series'; cadence: string; perDay: number; dropped: string[]; warnings: string[] }
  | { kind: 'frequency'; perDay: number; reason: string; warnings: string[] }
  | { kind: 'unmappable'; reason: string };

const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

interface Field { values: number[]; star: boolean; step: boolean; range: boolean }

/** One cron field → its values; null when unreadable. Names (mon…sun) only for the day of week. */
function parseField(raw: string, min: number, max: number, names?: Record<string, number>): Field | null {
  const out = new Set<number>();
  let star = false;
  let step = false;
  let range = false;
  const num = (s: string): number | null => {
    const low = s.toLowerCase();
    if (names && low in names) return names[low];
    if (!/^\d+$/.test(s)) return null;
    return Number(s);
  };
  for (const part of raw.split(',')) {
    if (!part) return null;
    const [base, stepRaw, extra] = part.split('/');
    if (extra !== undefined) return null;
    let by = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) return null;
      by = Number(stepRaw);
      step = true;
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min; hi = max;
      if (stepRaw === undefined) star = true;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      const x = num(a);
      const y = num(b);
      if (x === null || y === null) return null;
      lo = x; hi = y; range = true;
    } else {
      const x = num(base);
      if (x === null) return null;
      lo = x; hi = stepRaw === undefined ? x : max;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += by) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), star, step, range };
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Minutes the resource zone is ahead of the cron zone right now (DST: the offsets of `now`). */
export function zoneShiftMinutes(cronTz: string, targetTz: string, now: Date): number {
  if (cronTz === targetTz) return 0;
  return Math.round((tzOffsetMs(now, targetTz) - tzOffsetMs(now, cronTz)) / 60_000);
}

export function cronToCadence(i: CronInput): CronMapping {
  let fields = i.schedule.trim().split(/\s+/);
  if (fields.length === 6) {
    // The `cron` lib's optional seconds field: only a fixed second keeps a single fire per minute.
    if (!/^\d+$/.test(fields[0])) return { kind: 'unmappable', reason: `seconds field "${fields[0]}" fires more than once a minute` };
    fields = fields.slice(1);
  }
  if (fields.length !== 5) return { kind: 'unmappable', reason: `cron "${i.schedule}" is not a 5-field expression` };
  const [mRaw, hRaw, domRaw, monRaw, dowRaw] = fields;
  if (domRaw !== '*' && domRaw !== '?') return { kind: 'unmappable', reason: `day of month "${domRaw}" (series repeat daily or weekly)` };
  if (monRaw !== '*') return { kind: 'unmappable', reason: `month "${monRaw}" (series repeat daily or weekly)` };
  const minute = parseField(mRaw, 0, 59);
  const hour = parseField(hRaw, 0, 23);
  const dowField = dowRaw === '?' ? parseField('*', 0, 7) : parseField(dowRaw, 0, 7, DOW_NAMES);
  if (!minute || !hour || !dowField) return { kind: 'unmappable', reason: `cron "${i.schedule}" is not readable` };
  const dowAll = dowField.star || new Set(dowField.values.map((d) => d % 7)).size === 7;
  const days = dowAll ? null : [...new Set(dowField.values.map((d) => d % 7))].sort((a, b) => a - b);
  const daysPerWeek = days ? days.length : 7;
  const warnings: string[] = [];

  let minutes = minute.values;
  const minuteStep = minute.step || minute.star || minute.range;
  if (minuteStep && i.retryLoop) {
    // `*/10 19-20` retries until the digest posts once: one slot at the window's first time.
    minutes = [minute.values[0]];
    warnings.push(`retry cron "${i.schedule}" collapsed to its first time`);
  } else if (minuteStep) {
    const perDay = Math.min(24 * 60, hour.values.length * minute.values.length) * daysPerWeek / 7;
    return { kind: 'frequency', perDay: Math.round(perDay * 10) / 10, reason: `minute step "${mRaw}" (${hour.values.length * minute.values.length} runs a day)`, warnings };
  }
  const hours = i.retryLoop && minuteStep ? [hour.values[0]] : hour.values;

  // Scheduler zone → resource zone; a whole-day shift moves the weekdays too.
  const shift = zoneShiftMinutes(i.cronTz, i.targetTz, i.now);
  if (shift !== 0) warnings.push(`times converted from ${i.cronTz} to ${i.targetTz} (${shift > 0 ? '+' : ''}${shift} min at today's offsets)`);
  const local: Array<{ min: number; dayShift: number }> = [];
  for (const h of hours) {
    for (const m of minutes) {
      const t = h * 60 + m + shift;
      local.push({ min: ((t % 1440) + 1440) % 1440, dayShift: Math.floor(t / 1440) });
    }
  }
  const dropped = local.filter((t) => isQuietHour(Math.floor(t.min / 60), i.quiet.start, i.quiet.end)).map((t) => hhmm(t.min));
  const kept = local.filter((t) => !isQuietHour(Math.floor(t.min / 60), i.quiet.start, i.quiet.end));
  if (dropped.length) warnings.push(`dropped quiet-hour time${dropped.length > 1 ? 's' : ''} ${[...new Set(dropped)].sort().join(', ')}`);
  if (!kept.length) return { kind: 'unmappable', reason: `every time of "${i.schedule}" falls into quiet hours` };
  const times = [...new Set(kept.map((t) => hhmm(t.min)))].sort();
  if (times.length > MAX_SERIES_TIMES) {
    return { kind: 'frequency', perDay: Math.round(times.length * daysPerWeek / 7 * 10) / 10, reason: `${times.length} times a day (a series holds at most ${MAX_SERIES_TIMES})`, warnings };
  }
  let localDays = days;
  if (days) {
    const shifts = new Set(kept.map((t) => t.dayShift));
    if (shifts.size > 1) return { kind: 'unmappable', reason: `"${i.schedule}" crosses midnight in ${i.targetTz} on some times only (split it by hand)` };
    const s = [...shifts][0];
    if (s !== 0) localDays = [...new Set(days.map((d) => (((d + s) % 7) + 7) % 7))].sort((a, b) => a - b);
  }
  return { kind: 'series', cadence: formatCadence({ days: localDays, times }), perDay: Math.round(times.length * daysPerWeek / 7 * 10) / 10, dropped: [...new Set(dropped)].sort(), warnings };
}
