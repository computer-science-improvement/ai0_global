// Kyiv-day ranges of the spend reports (spec 029 FR-010/FR-011). Every day is a
// Europe/Kyiv calendar day written as YYYY-MM-DD; ranges are inclusive.

export const RANGES = ['today', '7d', '30d', 'mtd'] as const;
export type RangeKey = typeof RANGES[number];

/** Custom ranges are at most this many days (FR-010). */
export const MAX_RANGE_DAYS = 366;

export interface DayRange {
  from: string;
  to:   string;
  /** Inclusive day count. */
  days: number;
}

const DAY_MS = 86_400_000;

const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function isDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toMs(s)) && fromMs(toMs(s)) === s;
}

export function addDays(day: string, n: number): string {
  return fromMs(toMs(day) + n * DAY_MS);
}

/** Inclusive number of days from `from` to `to` (1 when equal). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1;
}

/** today | 7d | 30d | mtd → an inclusive day range ending today. */
export function presetRange(key: RangeKey, today: string): DayRange {
  switch (key) {
    case 'today': return { from: today, to: today, days: 1 };
    case '7d':    return { from: addDays(today, -6), to: today, days: 7 };
    case '30d':   return { from: addDays(today, -29), to: today, days: 30 };
    case 'mtd': {
      const from = `${today.slice(0, 8)}01`;
      return { from, to: today, days: daysBetween(from, today) };
    }
  }
}

/** The period of the same length right before `r` (for Δ). */
export function previousRange(r: DayRange): DayRange {
  return { from: addDays(r.from, -r.days), to: addDays(r.from, -1), days: r.days };
}

/** Every day of the range, oldest first. */
export function eachDay(r: DayRange): string[] {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Resolve `range` or a custom `from`/`to` (custom wins when both days are
 * given). Returns an error string for a bad or too long custom range.
 */
export function resolveRange(q: { range?: string; from?: string; to?: string }, today: string): DayRange | { error: string } {
  if (q.from || q.to) {
    if (!isDay(q.from) || !isDay(q.to)) return { error: 'from and to must both be YYYY-MM-DD days' };
    if (q.from > q.to) return { error: 'from is after to' };
    const days = daysBetween(q.from, q.to);
    if (days > MAX_RANGE_DAYS) return { error: `a custom range is at most ${MAX_RANGE_DAYS} days` };
    return { from: q.from, to: q.to, days };
  }
  const key = (q.range ?? '7d') as RangeKey;
  if (!RANGES.includes(key)) return { error: `range must be one of ${RANGES.join(', ')}` };
  return presetRange(key, today);
}
