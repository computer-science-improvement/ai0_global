// Spec 027 FR-015: first-paint cache of the saved menu (localStorage, try/catch:
// storage can be off, full or blocked; the default menu renders then).
import type { NavConfigResponse } from './config';

/** FR-015: the last GET /api/nav/config, so the saved menu paints without a flash. */
export const NAV_CACHE_KEY = 'dashboard:nav-cache';

export function readNavCache(): NavConfigResponse | undefined {
  try {
    const raw = localStorage.getItem(NAV_CACHE_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && 'config' in v && 'revision' in v ? (v as NavConfigResponse) : undefined;
  } catch { return undefined; }
}

export function writeNavCache(v: NavConfigResponse): void {
  try { localStorage.setItem(NAV_CACHE_KEY, JSON.stringify(v)); } catch { /* storage off or full */ }
}

