// Spec 023 FR-013: the Overview's "Upcoming slots" — the next series instances and owner pins of every agent,
// and (spec 034 FR-012) every other planned slot: a fixed topic or a live slot's scheduled fetch-and-write.
import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { LiveSpecView } from '../lib/slot-plan';

export interface UpcomingSlot {
  at:          string;
  kind:        'series' | 'pin' | 'slot';
  /** The series name, the pin's series / brief, or an ordinary slot's topic (a live slot: its label). */
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
  /** How the slot gets its topic (spec 034 FR-010); `live` = picked from the freshest item at slot time. */
  topicMode?:  'fixed' | 'live';
  live?:       LiveSpecView;
}

export function useUpcomingSlots(hours = 24, limit = 8) {
  return useQuery({
    queryKey: ['schedule', 'upcoming', hours, limit],
    queryFn:  () => api<{ now: string; hours: number; items: UpcomingSlot[] }>(`/api/schedule/upcoming?hours=${hours}&limit=${limit}`),
    refetchInterval: 60_000,
  });
}
