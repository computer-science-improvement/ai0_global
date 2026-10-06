// Spec 027 FR-004: the owner's menu as saved in the app_settings row `ui.nav`.
// Mirrors apps/automation/src/settings/nav/nav-config.schema.ts (shape only).

/** The menu schema this build writes. */
export const NAV_SCHEMA_VERSION = 1;

export interface NavGroupConfig {
  id:      string;
  title?:  string;
  hidden?: boolean;
  items:   string[];
}

export interface CustomLink {
  id:      string;
  label:   string;
  icon:    string;
  to:      string;
  search?: Record<string, string>;
}

export interface NavOverride {
  label?: string;
  icon?:  string;
  badge?: boolean;
}

export interface NavConfigV1 {
  schemaVersion: 1;
  groups:    NavGroupConfig[];
  pinned:    string[];
  hidden:    string[];
  custom:    CustomLink[];
  overrides: Record<string, NavOverride>;
}

/** GET /api/nav/config */
export interface NavConfigResponse {
  config:   Record<string, unknown> | null;
  revision: string | null;
  warning?: 'unparseable';
}

/** Server limits (FR-005), enforced in the constructor before a save. */
export const NAV_LIMITS = { groups: 20, refs: 150, custom: 50, pinned: 10, label: 40 } as const;

export const NAV_ID_RE = /^[a-z0-9_:-]{1,64}$/;

/** A short random lowercase id: `c_k3j9x2` (custom link) / `g_c_k3j9x2` (custom group). */
export function newNavId(prefix: 'c_' | 'g_c_'): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  return `${prefix}${s}`;
}

/** Internal /app path (no protocol, `//`, `:` or `..`), same rule as the server. */
export function isSafeNavPath(s: string): boolean {
  return /^\/app(\/|$)/.test(s) && s.length <= 300
    && !s.includes('//') && !s.includes(':') && !s.includes('..')
    && !/[?#\s\\]/.test(s);
}

/**
 * Parse what the owner typed or captured ("/app/channels?filter=external&q=crypto",
 * or a full dashboard URL) into `{to, search}`; null when it is not an internal page.
 */
export function parseNavTarget(input: string): { to: string; search?: Record<string, string> } | null {
  let raw = input.trim();
  if (!raw) return null;
  const abs = /^https?:\/\/[^/]+(\/.*)?$/i.exec(raw);
  if (abs) raw = abs[1] ?? '/';
  const [pathPart, query = ''] = raw.split('#', 1)[0].split(/\?(.*)/s, 2);
  const to = pathPart.length > 1 ? pathPart.replace(/\/+$/, '') : pathPart;
  if (!isSafeNavPath(to)) return null;
  const params = new URLSearchParams(query);
  const search: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of params) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k) || v.length > 200) return null;
    search[k] = v;
    if (++n > 10) return null;
  }
  return n ? { to, search } : { to };
}
