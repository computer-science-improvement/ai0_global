import { useQuery } from '@tanstack/react-query';
import { api } from './client';

// Spec 091 FR-008: the channel SLO controller's day rows — GET /api/editor/slo?day=YYYY-MM-DD.
// `rows` are the day's (one per channel); `history` the last 7 days per channel (the day included), newest first.

export type SloState = 'on_track' | 'behind' | 'recovering' | 'starved' | 'dark' | 'held' | 'met';

export interface SloRow {
  channelKey:   string;
  /** The channel's local day, YYYY-MM-DD. */
  day:          string;
  target:       number;
  published:    number;
  plannedAhead: number;
  skipped:      number;
  replacements: number;
  recoveryRuns: number;
  state:        SloState;
  /** One English line. */
  reason:       string | null;
  lastPostAt:   string | null;
  darkSince:    string | null;
  updatedAt:    string;
}

export interface SloResponse { day: string; rows: SloRow[]; history: SloRow[] }

export const sloPath = (day?: string): string => `/api/editor/slo${day ? `?day=${encodeURIComponent(day)}` : ''}`;
export const fetchSlo = (day?: string) => api<SloResponse>(sloPath(day));

export function useSlo(day?: string) {
  return useQuery({ queryKey: ['editor-slo', day ?? null], queryFn: () => fetchSlo(day), refetchInterval: 60_000 });
}
