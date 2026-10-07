// Spec 023 FR-007: pure helpers of the agent's Schedule tab — one lane per
// resource, one cell per day (resource-local dates from the server), cadence
// building for the series form and the English labels. No React here, so the
// node tests can import it.

import type { ScheduleItem, ScheduleResponse, ScheduleRule, ScheduleSlot, SeriesSource } from '../api/schedule';

export type EntryKind = 'series' | 'pin' | 'blackout' | 'frequency' | 'slot' | 'reserved';

export interface Entry {
  key:     string;
  kind:    EntryKind;
  /** Resource-local HH:MM (frequency rules: empty, they sort first). */
  time:    string;
  until?:  string;
  title:   string;
  sub?:    string;
  locked?: boolean;
  /** The slot that realises a series instance or a pin, or a free slot's status. */
  status?: string;
  ruleId?: string;
  series?: string;
}

const SERIES_WINDOW_MIN = 90;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Entries of one lane and day: series instances and pins take the status of the slot that realises them
 * (a series slot within ±90 min, the pin's own slot); every other slot is listed on its own.
 */
export function cellEntries(s: Pick<ScheduleResponse, 'items' | 'slots'>, ref: string, date: string): Entry[] {
  const items = s.items.filter((i) => i.resourceRef === ref && i.date === date);
  const slots = s.slots.filter((x) => x.resourceRef === ref && x.date === date);
  const used = new Set<string>();
  const out: Entry[] = [];
  for (const i of items) out.push(itemEntry(i, slots, used));
  for (const x of slots) {
    if (used.has(x.id)) continue;
    out.push({
      key: `slot:${x.id}`, kind: x.kind === 'reserved' ? 'reserved' : 'slot', time: x.time, title: x.topic,
      sub: x.kind === 'reserved' ? (x.promo ? 'promo' : 'reserved') : x.format, status: x.status,
      ...(x.seriesName ? { series: x.seriesName } : {}),
    });
  }
  return out.sort((a, b) => (a.time || '00:00').localeCompare(b.time || '00:00') || order(a.kind) - order(b.kind));
}

const ORDER: Record<EntryKind, number> = { frequency: 0, blackout: 1, pin: 2, series: 3, slot: 4, reserved: 5 };
const order = (k: EntryKind) => ORDER[k];

function itemEntry(i: ScheduleItem, slots: ScheduleSlot[], used: Set<string>): Entry {
  switch (i.kind) {
    case 'series': {
      const hit = slots.find((x) => !used.has(x.id) && x.seriesName === i.name && Math.abs(minutes(x.time) - minutes(i.time)) <= SERIES_WINDOW_MIN);
      if (hit) used.add(hit.id);
      return {
        key: `series:${i.name}:${i.time}`, kind: 'series', time: hit?.time ?? i.time, title: i.name, sub: i.format, locked: i.locked,
        series: i.name, ...(hit ? { status: hit.status } : {}),
      };
    }
    case 'pin': {
      const hit = slots.find((x) => !used.has(x.id) && x.scheduleRuleId === i.ruleId);
      if (hit) used.add(hit.id);
      return {
        key: `pin:${i.ruleId}`, kind: 'pin', time: i.time, title: i.seriesName ?? i.brief ?? 'Pinned post', sub: i.format ?? undefined,
        ruleId: i.ruleId, locked: true, ...(hit ? { status: hit.status } : {}),
      };
    }
    case 'blackout':
      return { key: `blackout:${i.ruleId}`, kind: 'blackout', time: i.time, until: i.until, title: 'No posts', ruleId: i.ruleId };
    default:
      return { key: `freq:${i.ruleId}`, kind: 'frequency', time: '', title: `${i.min ?? '…'}–${i.max ?? '…'} posts`, ruleId: i.ruleId };
  }
}

// ── cadence (series form) ──

export const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** Monday-first order for day pickers. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseCadence(c: string): { days: number[] | null; times: string[] } | null {
  const m = /^(daily|weekly:([a-z]{3}(?:,[a-z]{3})*))@(\d{2}:\d{2}(?:,\d{2}:\d{2})*)$/.exec(c.trim());
  if (!m) return null;
  const times = m[3].split(',');
  if (m[1] === 'daily') return { days: null, times };
  return { days: m[2].split(',').map((d) => DOW.indexOf(d as typeof DOW[number])).filter((d) => d >= 0), times };
}

/** Days (null or all seven = daily) + "19:00, 21:30" → a cadence, or an English error. */
export function buildCadence(days: number[] | null, timesText: string): { cadence: string } | { error: string } {
  const times = [...new Set(timesText.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean).map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t)))].sort();
  if (!times.length) return { error: 'Add at least one time (HH:MM)' };
  const bad = times.filter((t) => !TIME_RE.test(t));
  if (bad.length) return { error: `Not a time: ${bad.join(', ')} (use HH:MM)` };
  if (times.length > 6) return { error: 'At most 6 times a day' };
  if (days && !days.length) return { error: 'Pick at least one day' };
  const all = !days || days.length === 7;
  return { cadence: all ? `daily@${times.join(',')}` : `weekly:${[...new Set(days!)].sort((a, b) => a - b).map((d) => DOW[d]).join(',')}@${times.join(',')}` };
}

/** "every day", "weekdays", "weekends", "Mon, Thu". */
export function daysLabel(days: number[] | null | undefined): string {
  if (!days || days.length === 7) return 'every day';
  const s = [...days].sort((a, b) => a - b).join(',');
  if (s === '1,2,3,4,5') return 'weekdays';
  if (s === '0,6') return 'weekends';
  return WEEK.filter((d) => days.includes(d)).map((d) => DAY_SHORT[d]).join(', ');
}

export function cadenceLabel(c: string): string {
  const p = parseCadence(c);
  return p ? `${daysLabel(p.days)} ${p.times.join(', ')}` : c;
}

export function sourceLabel(s: SeriesSource | null | undefined): string {
  if (!s) return 'no source';
  switch (s.kind) {
    case 'library': return `library: ${s.table}${s.category ? ` / ${s.category}` : ''}`;
    case 'api': return `API: ${s.source}`;
    case 'feed': return `feed: ${s.ref}`;
    case 'network_highlights': return `network highlights (${s.scope})`;
    default: return 'free choice';
  }
}

/** One English line for a rule ("Pin 19:00 weekdays · photo", "No posts 13:00–15:00 every day"). */
export function ruleLabel(r: Pick<ScheduleRule, 'kind' | 'days' | 'at_local' | 'until_local' | 'format' | 'series_name' | 'per_day_min' | 'per_day_max'>): string {
  if (r.kind === 'pin') return `Pin ${r.at_local} ${daysLabel(r.days)}${r.series_name ? ` · series "${r.series_name}"` : ''}${r.format ? ` · ${r.format}` : ''}`;
  if (r.kind === 'blackout') return `No posts ${r.at_local}–${r.until_local} ${daysLabel(r.days)}`;
  return `${r.per_day_min ?? '…'}–${r.per_day_max ?? '…'} posts a day ${daysLabel(r.days)}`;
}

export function validityLabel(r: Pick<ScheduleRule, 'valid_from' | 'valid_until'>): string | null {
  if (!r.valid_from && !r.valid_until) return null;
  return `${r.valid_from ? fmtDate(r.valid_from) : '…'} – ${r.valid_until ? fmtDate(r.valid_until) : '…'}`;
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const utc = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
export const fmtDate = (d: string) => DATE_FMT.format(utc(d));
export const fmtDayHead = (d: string) => DAY_FMT.format(utc(d));

/** "GMT+3" (the zone's short label at an instant), for "Times in Europe/Kyiv (GMT+3)". */
export function tzShort(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  } catch { return tz; }
}

/** Warning codes from the server, in English. */
export const WARNING_TEXT: Record<string, string> = {
  quiet_hours: 'it falls in the quiet hours',
  inside_blackout: 'it falls in a blackout window',
  conflicts_with_reserved: 'it is close to a reserved (ad) slot — both stay',
  blackout_window: 'it is inside a blackout window',
};

export function warningsText(codes: string[]): string | null {
  return codes.length ? `Saved, but ${codes.map((c) => WARNING_TEXT[c] ?? c.replace(/_/g, ' ')).join('; ')}.` : null;
}
