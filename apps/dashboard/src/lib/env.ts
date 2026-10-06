import { resolveAuthMode, tokenFormEnabled } from './auth-mode';

// `?? {}`: outside Vite (node:test via tsx) `import.meta.env` is undefined.
const ENV = (import.meta.env ?? {}) as Record<string, string | undefined>;

// Every api() path already carries its full backend prefix (`/api/strategies`,
// `/tracking/…`), and both the vite dev proxy and the prod nginx forward those
// paths unchanged — so the base is empty by default. Set VITE_API_BASE_URL only
// to point at a different origin (e.g. `https://api.example.com`).
export const API_BASE = ENV.VITE_API_BASE_URL ?? '';
export const AUTH_BASE = ENV.VITE_AUTH_BASE_URL ?? '/auth';
export const TG_BOT_USERNAME = ENV.VITE_TG_BOT_USERNAME ?? '';

/** telegram | token | dev — see lib/auth-mode.ts. Baked in at build time. */
export const AUTH_MODE = resolveAuthMode(ENV);
/** Token sign-in available (the main form in token mode, a collapsed extra in Telegram mode). */
export const TOKEN_LOGIN = tokenFormEnabled(ENV);
