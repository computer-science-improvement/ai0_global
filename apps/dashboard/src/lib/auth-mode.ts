/**
 * How the dashboard authenticates — shared by the app (`lib/env.ts`) and the
 * build check in `vite.config.ts`, so both read the same rule:
 *   telegram — Telegram Login Widget (needs a domain + BotFather /setdomain);
 *              wins when a bot username is set
 *   token    — paste the shared access token (works on plain HTTP)
 *   dev      — no sign-in method: only the backend's local no-auth bypass
 * A production build in `dev` mode fails unless explicitly allowed
 * (spec 028 FR-013), and a dev build served from a non-local host shows a
 * red "no sign-in method" banner instead of "Continue".
 */
export type AuthMode = 'telegram' | 'token' | 'dev';

export function resolveAuthMode(env: Record<string, string | undefined>): AuthMode {
  if (env.VITE_TG_BOT_USERNAME?.trim()) return 'telegram';
  if (env.VITE_AUTH_MODE?.trim() === 'token') return 'token';
  return 'dev';
}

/** The token form is offered in token mode, and (collapsed) in Telegram mode when token mode is also set. */
export function tokenFormEnabled(env: Record<string, string | undefined>): boolean {
  return env.VITE_AUTH_MODE?.trim() === 'token';
}

/** Why a production build must not ship, or null when it may. */
export function devAuthBuildError(env: Record<string, string | undefined>): string | null {
  if (resolveAuthMode(env) !== 'dev') return null;
  if (env.VITE_ALLOW_DEV_AUTH?.trim() === 'true') return null;
  return 'Refusing a production build without a sign-in method: set VITE_AUTH_MODE=token '
    + 'and/or VITE_TG_BOT_USERNAME (or VITE_ALLOW_DEV_AUTH=true for a deliberate local-only build).';
}

/** localhost, 127.0.0.1, ::1 and *.localhost — where a dev build is acceptable. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}
