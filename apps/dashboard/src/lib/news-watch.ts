// Spec 034 FR-011: the news watch settings of a Telegram news resource (resource profile `news_watch`):
// the form state, the stored body (only what differs from the defaults) and the one-line summary.

import type { NewsWatchSettings } from '../api/agents';

export const NEWS_WATCH_DEFAULTS = { every_hours: 2, from_hour: 8, to_hour: 22, max_per_day: 3 } as const;

export const pad2 = (n: number) => String(n).padStart(2, '0');

export interface NewsWatchForm {
  /** auto = on for news resources (a card with RSS feeds whose brief says news). */
  mode:  'auto' | 'on' | 'off';
  every: string;
  from:  string;
  to:    string;
  max:   string;
}

export function newsWatchForm(w: NewsWatchSettings | null | undefined): NewsWatchForm {
  return {
    mode: w?.enabled === true ? 'on' : w?.enabled === false ? 'off' : 'auto',
    every: String(w?.every_hours ?? NEWS_WATCH_DEFAULTS.every_hours),
    from: String(w?.from_hour ?? NEWS_WATCH_DEFAULTS.from_hour),
    to: String(w?.to_hour ?? NEWS_WATCH_DEFAULTS.to_hour),
    max: String(w?.max_per_day ?? NEWS_WATCH_DEFAULTS.max_per_day),
  };
}

/** The stored settings: only what differs from the defaults (so a later change of a default applies). */
export function newsWatchBody(f: NewsWatchForm, prev?: NewsWatchSettings | null): NewsWatchSettings {
  const n = (s: string) => Number(s);
  const out: NewsWatchSettings = {};
  if (f.mode !== 'auto') out.enabled = f.mode === 'on';
  if (n(f.every) !== NEWS_WATCH_DEFAULTS.every_hours) out.every_hours = n(f.every);
  if (n(f.from) !== NEWS_WATCH_DEFAULTS.from_hour) out.from_hour = n(f.from);
  if (n(f.to) !== NEWS_WATCH_DEFAULTS.to_hour) out.to_hour = n(f.to);
  if (n(f.max) !== NEWS_WATCH_DEFAULTS.max_per_day) out.max_per_day = n(f.max);
  // Not editable here; kept as stored.
  if (prev?.max_age_hours !== undefined) out.max_age_hours = prev.max_age_hours;
  return out;
}

export function newsWatchError(f: NewsWatchForm): string | null {
  if (f.mode === 'off') return null;
  return Number(f.from) < Number(f.to) ? null : 'the start hour must be before the end hour';
}

/** When it runs, for the profile view (empty when off). */
export function newsWatchWhen(w: NewsWatchSettings | null | undefined): string {
  const f = newsWatchForm(w);
  if (f.mode === 'off') return '';
  return `every ${f.every} h · ${pad2(Number(f.from))}:00–${pad2(Number(f.to))}:00 · up to ${f.max} added a day`;
}

/** Inclusive hour range for the selects. */
export const hourRange = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
