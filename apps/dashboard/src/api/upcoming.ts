// Spec 023 FR-013: the Overview's "Upcoming slots" — the next series instances and owner pins of every agent.
import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface UpcomingSlot {
  at:          string;
  kind:        'series' | 'pin';
  name:        string;
  format:      string | null;
  resourceRef: string;
  channelKey:  string;
  agent:       string;
  /** Owner-locked series, or a pin (always the owner's). */
  owner:       boolean;
  origin:      string | null;
  /** Status of the slot that realises it (planned, shadowed, awaiting_approval, …); null = not planned yet. */
  status:      string | null;
  slotId:      string | null;
}

export function useUpcomingSlots(hours = 24, limit = 8) {
  return useQuery({
    queryKey: ['schedule', 'upcoming', hours, limit],
    queryFn:  () => api<{ now: string; hours: number; items: UpcomingSlot[] }>(`/api/schedule/upcoming?hours=${hours}&limit=${limit}`),
    refetchInterval: 60_000,
  });
}
