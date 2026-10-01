/** Timezone helpers without a date library (Intl-based, DST-correct). */

function parts(d: Date, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(d)) {
    if (p.type === 'weekday') out.weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.value);
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset (ms) of `tz` from UTC at instant `d`. */
export function tzOffsetMs(d: Date, tz: string): number {
  const p = parts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** 'YYYY-MM-DD' of instant `d` in `tz`. */
export function localDate(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localHour(d: Date, tz: string): number {
  return parts(d, tz).hour;
}

/** 0 = Sunday … 6 = Saturday, in `tz`. */
export function localWeekday(d: Date, tz: string): number {
  return parts(d, tz).weekday;
}

export function localTimeLabel(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Instant for wall-clock `date` + `hhmm` in `tz` (second pass fixes DST edges). */
export function zonedToUtc(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

/** Quiet window [start, end) in local hours; start === end means no quiet hours. */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}
