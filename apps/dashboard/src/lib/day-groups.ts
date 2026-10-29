// Pure day helpers for the pages that talk about "today" in Kyiv time (the editor pages, the logs timeline; spec 078 C3).
// No React, so node:test covers them (day-groups.test.ts). Calendar maths runs in UTC on the YYYY-MM-DD string, so the
// browser's own zone never shifts a label.

import { KYIV_TZ, dayIn } from './zoned-time';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "Thu, 29 Oct" of a YYYY-MM-DD day; anything else comes back as given. */
export function fmtDayShort(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return day;
  return `${WEEKDAY[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** The mono overline of a page about one day: "Thu, 29 Oct · Kyiv". `null` when the day is not known yet. */
export function dayEyebrow(day: string | null | undefined, zone = 'Kyiv'): string | null {
  if (!day || !DAY_RE.test(day)) return null;
  return `${fmtDayShort(day)} · ${zone}`;
}

/** The day before a YYYY-MM-DD day. */
export function previousDay(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", "Thu, 29 Oct", or "Mon, 3 Nov 2025" for a day of another year. */
export function dayHeading(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === previousDay(today)) return 'Yesterday';
  const short = fmtDayShort(day);
  return DAY_RE.test(day) && day.slice(0, 4) !== today.slice(0, 4) ? `${short} ${day.slice(0, 4)}` : short;
}

export interface DayGroup<T> { day: string; items: T[] }

/**
 * Groups a newest-first list of `{at}` rows by the day they happened in `tz`. The order of the rows is kept, and so is the
 * order of the days: a row only joins the group before it when it is on the same day. A row with a broken date gets its own
 * group named "—" so it is never silently dropped.
 */
export function groupByDay<T extends { at: string }>(items: readonly T[], tz: string = KYIV_TZ): Array<DayGroup<T>> {
  const out: Array<DayGroup<T>> = [];
  for (const it of items) {
    const t = new Date(it.at).getTime();
    const day = Number.isNaN(t) ? '—' : dayIn(t, tz);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}
