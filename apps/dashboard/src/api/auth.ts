import { AUTH_BASE } from '../lib/env';
import type { Me } from './types';

export interface TelegramLoginPayload {
  id: number; first_name: string; last_name?: string; username?: string;
  photo_url?: string; auth_date: number; hash: string;
}

export const authApi = {
  telegramLogin: (payload: TelegramLoginPayload) =>
    fetch(`${AUTH_BASE}/telegram-login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => { if (!r.ok) throw new Error(`auth failed: ${r.status}`); return r.json() as Promise<Me>; }),
  me:     () => fetch(`${AUTH_BASE}/me`, { credentials: 'include' }).then((r) => r.ok ? r.json() as Promise<Me | null> : null),
  logout: () => fetch(`${AUTH_BASE}/logout`, { method: 'POST', credentials: 'include' }),
};
