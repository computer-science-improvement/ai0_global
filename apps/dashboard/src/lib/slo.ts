// Spec 091 FR-008: the "Channels" panel on /app/health — the words, tones, ordering and 7-day strip of the SLO rows. Pure, node-tested.
import type { SloResponse, SloRow, SloState } from '../api/slo';

export const SLO_STATE_LABEL: Record<SloState, string> = {
  met: 'Met', on_track: 'On track', behind: 'Behind', recovering: 'Recovering', starved: 'Starved', dark: 'Dark', held: 'Held',
};

export const SLO_STATE_TONE: Record<SloState, 'neutral' | 'success' | 'warning' | 'danger' | 'accent'> = {
  met: 'success', on_track: 'accent', behind: 'warning', recovering: 'accent', starved: 'danger', dark: 'danger', held: 'neutral',
};

/** What each state means, for the badge tooltip. */
export const SLO_STATE_HINT: Record<SloState, string> = {
  met: 'The daily minimum is out.',
  on_track: 'Enough posts are out or planned to reach the minimum.',
  behind: 'Fewer posts are out or planned than the minimum needs.',
  recovering: 'A replacement or recovery run is in progress.',
  starved: 'No cheap way is left to reach the minimum today (no material).',
  dark: 'No post for a day or more.',
  held: 'Nothing is owed today (off, shadow, paused).',
};

/** Worst first: what needs a look is on top. */
const ORDER: SloState[] = ['dark', 'starved', 'behind', 'recovering', 'on_track', 'met', 'held'];

/** `YYYY-MM-DD` shifted by whole days (calendar arithmetic, no zone). */
export function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}

export type DayMark = 'met' | 'missed' | 'held' | 'today' | 'none';

/**
 * The mark of one day on the strip: `held` days (target 0) are neutral; a finished day is `met` when published reached the
 * target and `missed` when the target was higher; the running day is `met` once it is, else `today` (not decided yet);
 * a day without a row is `none`.
 */
export function dayMark(row: SloRow | undefined, today: string, day: string): DayMark {
  if (!row) return 'none';
  if (row.state === 'held' || row.target === 0) return 'held';
  if (row.published >= row.target) return 'met';
  return day === today ? 'today' : 'missed';
}

export interface StripCell { day: string; mark: DayMark; row: SloRow | null }

/** The last `days` days ending at `today`, oldest first. */
export function strip(history: SloRow[], channelKey: string, today: string, days = 7): StripCell[] {
  const byDay = new Map(history.filter((r) => r.channelKey === channelKey).map((r) => [r.day, r]));
  const out: StripCell[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = shiftDay(today, -i);
    const row = byDay.get(day);
    out.push({ day, mark: dayMark(row, today, day), row: row ?? null });
  }
  return out;
}

export interface ChannelView {
  row:     SloRow;
  /** Share of the target that is out, 0..100 (a target of 0 is 100). */
  pct:     number;
  strip:   StripCell[];
  /** Missed days on the strip. */
  missed:  number;
}

export const barPct = (published: number, target: number): number => (target <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((published / target) * 100))));

/** The panel's rows: worst state first, then the channel key. */
export function channelViews(data: SloResponse): ChannelView[] {
  return [...data.rows]
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.channelKey.localeCompare(b.channelKey))
    .map((row) => {
      const s = strip(data.history, row.channelKey, data.day);
      return { row, pct: barPct(row.published, row.target), strip: s, missed: s.filter((c) => c.mark === 'missed').length };
    });
}

/** The panel head's count: how many channels are below their minimum with no end in sight (behind, recovering, starved, dark). */
export function belowTarget(views: ChannelView[]): number {
  return views.filter((v) => v.row.state === 'behind' || v.row.state === 'recovering' || v.row.state === 'starved' || v.row.state === 'dark').length;
}

export const MARK_LABEL: Record<DayMark, string> = { met: 'met', missed: 'missed', held: 'held', today: 'in progress', none: 'no data' };

/** Screen-reader text of the strip: "2026-11-04 missed, 2026-11-05 no data, …". */
export function stripText(cells: StripCell[]): string {
  return cells.map((c) => `${c.day} ${MARK_LABEL[c.mark]}`).join(', ');
}

/** "1 replacement · 2 recovery runs", or an empty string when there are none. */
export function effortText(row: Pick<SloRow, 'replacements' | 'recoveryRuns'>): string {
  const bits: string[] = [];
  if (row.replacements) bits.push(`${row.replacements} replacement${row.replacements === 1 ? '' : 's'}`);
  if (row.recoveryRuns) bits.push(`${row.recoveryRuns} recovery run${row.recoveryRuns === 1 ? '' : 's'}`);
  return bits.join(' · ');
}
