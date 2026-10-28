import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { NavConfigResponse, NavConfig } from '../nav/config';

/** The items behind the menu counters (GET /api/nav/attention). */
export interface NavAttention {
  inbox:      { total: number; items: Array<{ id: number; title: string; severity: 'info' | 'action' | 'critical'; kind: string; agentHandle: string | null; createdAt: string }> };
  directives: { total: number; items: Array<{ id: string; kind: string; body: string; status: string; agentHandle: string | null; createdAt: string }> };
  chatCards:  { total: number; items: Array<{ id: string; chatId: string | null; chatTitle: string | null; kind: string; summary: string; agentHandle: string | null; createdAt: string }> };
}

export interface NavBadgesResponse {
  generatedAt: string;
  /** null = that source failed or its table is missing: no badge. */
  counts: Record<string, number | null>;
}

// Spec 027: the owner's menu (GET/PUT/DELETE /api/nav/config) and its counters.
export const navApi = {
  getConfig: () => api<NavConfigResponse>('/api/nav/config'),
  putConfig: (config: NavConfig, baseRevision: string | null) =>
    api<{ revision: string }>('/api/nav/config', { method: 'PUT', body: JSON.stringify({ config, baseRevision }) }),
  resetConfig: () => api<{ revision: null }>('/api/nav/config', { method: 'DELETE' }),
  getBadges: (fresh = false) => api<NavBadgesResponse>(`/api/nav/badges${fresh ? '?fresh=1' : ''}`),
  getAttention: () => api<NavAttention>('/api/nav/attention'),
};

export const NAV_CONFIG_KEY = ['nav', 'config'] as const;
export const NAV_BADGES_KEY = ['nav', 'badges'] as const;
export const NAV_ATTENTION_KEY = ['nav', 'attention'] as const;

/** What waits for the owner, item by item (the pages a menu counter leads to show it on top). */
export function useNavAttention() {
  return useQuery({
    queryKey: NAV_ATTENTION_KEY,
    queryFn: () => navApi.getAttention(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

/**
 * FR-011: after a change that can move a counter (inbox read, directive decided,
 * pending action applied, DM thread or agent action handled, scheduled post
 * edited…), the next badges fetch asks the server to skip its 10 s cache.
 */
let freshNext = false;
export function requestFreshBadges(): void { freshNext = true; }
export function takeFreshBadges(): boolean { const f = freshNext; freshNext = false; return f; }
