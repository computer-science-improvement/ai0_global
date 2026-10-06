// Every api() path already carries its full backend prefix (`/api/strategies`,
// `/tracking/…`), and both the vite dev proxy and the prod nginx forward those
// paths unchanged — so the base is empty by default. Set VITE_API_BASE_URL only
// to point at a different origin (e.g. `https://api.example.com`).
// `?? {}`: outside Vite (node:test via tsx) `import.meta.env` is undefined.
const ENV = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const API_BASE = ENV.VITE_API_BASE_URL ?? '';
export const AUTH_BASE = ENV.VITE_AUTH_BASE_URL ?? '/auth';
export const TG_BOT_USERNAME = ENV.VITE_TG_BOT_USERNAME ?? '';

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
  : ENV.VITE_AUTH_MODE === 'token' ? 'token'
  : 'dev';
