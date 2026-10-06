import { AUTH_BASE } from '../lib/env';
import type { AuthEvent, AuthSession, Me } from './types';
import type { SessionInfo } from '../auth/session';
import { api } from './client';

export interface TelegramLoginPayload {
  id: number; first_name: string; last_name?: string; username?: string;
  photo_url?: string; auth_date: number; hash: string;
}

/**
 * A failed sign-in. `code` is the backend's FR-007 code (`bad_token`,
 * `rate_limited`, …), `network` when the server could not be reached, or
 * `unknown` for anything else.
 */
export class LoginError extends Error {
  constructor(public code: string, public status: number, public retryAfterSec?: number) { super(code); }
}

async function login(path: string, body: unknown): Promise<Me> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/${path}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new LoginError('network', 0);
  }
  if (res.ok) return res.json() as Promise<Me>;
  let data: { code?: unknown; retryAfterSec?: unknown } = {};
  try { data = await res.json(); } catch { /* no JSON body (proxy error page) */ }
  const header = Number(res.headers.get('Retry-After'));
  const retry = typeof data.retryAfterSec === 'number' ? data.retryAfterSec : Number.isFinite(header) && header > 0 ? header : undefined;
  const code = typeof data.code === 'string' ? data.code : res.status >= 500 ? 'network' : 'unknown';
  throw new LoginError(code, res.status, retry);
}

export const authApi = {
  telegramLogin: (payload: TelegramLoginPayload) => login('telegram-login', payload),
  /** `via: 'link'` marks a sign-in from an authorization link (audited as such). */
  tokenLogin: (token: string, via: 'form' | 'link' = 'form') => login('token-login', { token, via }),

  /** `/auth/me` plus the reason a cookie stopped working. Throws when the server can't answer. */
  session: async (): Promise<SessionInfo> => {
    const r = await fetch(`${AUTH_BASE}/me`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) throw new Error(`auth check failed: ${r.status}`);
    // Nest sends a handler's `null` as an empty 200 body.
    const text = await r.text();
    const me = (text ? JSON.parse(text) : null) as Me | null;
    return { me, reason: me ? null : r.headers.get('X-Auth-Reason') };
  },
  logout: () => fetch(`${AUTH_BASE}/logout`, { method: 'POST', credentials: 'include' }),

  // Settings → Security (guarded; 401s go through the shared api() handler).
  sessions:   () => api<AuthSession[]>('/auth/sessions'),
  revoke:     (id: string) => api<{ ok: true; revoked: boolean; current: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeAll:  (includeCurrent: boolean) =>
    api<{ ok: true; revoked: number; current: boolean }>('/auth/sessions/revoke-all', { method: 'POST', body: JSON.stringify({ includeCurrent }) }),
  events:     (limit = 50) => api<AuthEvent[]>(`/auth/events?limit=${limit}`),
};
