import { api } from './client';
import type { NavConfigResponse, NavConfigV1 } from '../nav/config';

export interface NavBadgesResponse {
  generatedAt: string;
  /** null = that source failed or its table is missing: no badge. */
  counts: Record<string, number | null>;
}

// Spec 027: the owner's menu (GET/PUT/DELETE /api/nav/config) and its counters.
export const navApi = {
  getConfig: () => api<NavConfigResponse>('/api/nav/config'),
  putConfig: (config: NavConfigV1, baseRevision: string | null) =>
    api<{ revision: string }>('/api/nav/config', { method: 'PUT', body: JSON.stringify({ config, baseRevision }) }),
  resetConfig: () => api<{ revision: null }>('/api/nav/config', { method: 'DELETE' }),
  getBadges: (fresh = false) => api<NavBadgesResponse>(`/api/nav/badges${fresh ? '?fresh=1' : ''}`),
};

export const NAV_CONFIG_KEY = ['nav', 'config'] as const;
export const NAV_BADGES_KEY = ['nav', 'badges'] as const;

/**
 * FR-011: after a change that can move a counter (inbox read, directive decided,
 * pending action applied, DM thread or agent action handled, scheduled post
 * edited…), the next badges fetch asks the server to skip its 10 s cache.
 */
let freshNext = false;
export function requestFreshBadges(): void { freshNext = true; }
export function takeFreshBadges(): boolean { const f = freshNext; freshNext = false; return f; }
