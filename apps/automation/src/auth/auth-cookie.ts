import type { Response } from 'express';

export const SESSION_COOKIE = 'tracking_jwt';

/** Header carrying the 401 reason where the body can't (nginx auth_request, `/auth/me` → null). */
export const AUTH_REASON_HEADER = 'X-Auth-Reason';

function baseOptions(production: boolean) {
  return { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
}

export function setSessionCookie(res: Response, token: string, maxAgeMs: number, production: boolean): void {
  res.cookie(SESSION_COOKIE, token, { ...baseOptions(production), maxAge: maxAgeMs });
}

/**
 * clearCookie only deletes when the attributes match the Set-Cookie that
 * created it — otherwise the browser keeps the session cookie and the user
 * stays logged in. Same options as setSessionCookie.
 */
export function clearSessionCookie(res: Response, production: boolean): void {
  res.clearCookie(SESSION_COOKIE, baseOptions(production));
}
