import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Spec 012 FR-007: the owner bot — GET /api/owner-bot (state), POST /api/owner-bot/test-card,
// POST /api/owner-bot/reports/daily|weekly (sent now; the scheduled one still goes at its time).

/** The card kinds of the owner bot (spec 012 FR-002). */
export type OwnerCardKind = 'approval' | 'directive' | 'contested' | 'action' | 'steering' | 'setup' | 'playbook' | 'inbox';

export interface OwnerBotState {
  configured: { token: boolean; owner: boolean };
  cardsOn:    boolean;
  polling:    { running: boolean; lastPollAt: string | null; lastUpdateAt: string | null; lastError: string | null };
  cards:      { open: number; queued: number; sentToday: number; failedToday: number };
  waiting:    Array<{ kind: OwnerCardKind | string; count: number }>;
  settings:   { quietHours: string; maxPerHour: number; dailyAt: string; weeklyAt: string };
  reports:    { dailyAt: string | null; weeklyAt: string | null };
}

export function useOwnerBot() {
  return useQuery({
    queryKey: ['owner-bot'],
    queryFn:  () => api<OwnerBotState>('/api/owner-bot'),
    refetchInterval: 60_000,
  });
}

export function useOwnerBotTestCard() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: () => api<{ sent: boolean }>('/api/owner-bot/test-card', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['owner-bot'] }),
  });
}

export function useOwnerBotReport() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: (kind: 'daily' | 'weekly') => api<{ sent: boolean }>(`/api/owner-bot/reports/${kind}`, { method: 'POST' }),
  });
}
