import { api } from './client';
import type { NavConfigResponse, NavConfigV1 } from '../nav/config';

// Spec 027: the owner's menu (GET/PUT/DELETE /api/nav/config).
export const navApi = {
  getConfig: () => api<NavConfigResponse>('/api/nav/config'),
  putConfig: (config: NavConfigV1, baseRevision: string | null) =>
    api<{ revision: string }>('/api/nav/config', { method: 'PUT', body: JSON.stringify({ config, baseRevision }) }),
  resetConfig: () => api<{ revision: null }>('/api/nav/config', { method: 'DELETE' }),
};

export const NAV_CONFIG_KEY = ['nav', 'config'] as const;
