export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) ?? '/api';
export const AUTH_BASE = (import.meta.env.VITE_AUTH_BASE_URL as string) ?? '/auth';
export const TG_BOT_USERNAME = (import.meta.env.VITE_TG_BOT_USERNAME as string) ?? '';

/**
 * How the dashboard authenticates:
 *   telegram — Telegram Login Widget (needs a domain + BotFather /setdomain)
 *   token    — paste the shared TRACKING_TOKEN secret (works on plain HTTP)
 *   dev      — no auth; placeholder Dev user (local only)
 * Telegram wins if a bot username is set; otherwise opt into token mode with
 * VITE_AUTH_MODE=token; default is the dev bypass.
 */
export const AUTH_MODE: 'telegram' | 'token' | 'dev' =
  TG_BOT_USERNAME ? 'telegram'
  : (import.meta.env.VITE_AUTH_MODE as string) === 'token' ? 'token'
  : 'dev';
