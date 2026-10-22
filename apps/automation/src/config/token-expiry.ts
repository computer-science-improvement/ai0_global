/**
 * Spec 061 FR-006: an expired Meta session is a state, not an error to repeat. "Error validating access token: Session has
 * expired on Wednesday, 14-Oct-26 08:00:00 PDT" (code 190, subcode 463 expired / 467 invalid session) used to fail the
 * hourly collector 24 times a day and log 24 lines, while health showed the raw error. Now the account is marked expired
 * (`token_expires_at` = the date in the error, else now), health says «токен прострочено з <date>», the collector asks
 * such an account once a day, and the keeper counts it expired.
 */
export const EXPIRED_PREFIX = 'токен прострочено з ';
/** The collector asks an account with an expired token again after this long. */
export const EXPIRED_RETRY_MS = 24 * 3_600_000;

const SESSION_RE = /session has expired|session is invalid|the session has been invalidated/i;
const CODE_RE = /\(#?190\)|\bcode[":\s=]*190\b/i;
const SUBCODE_RE = /sub-?code[":\s=]*(463|467)\b|error_subcode[":\s=]*(463|467)\b/i;

/** Does this error text mean the token's session is over (not a wrong target, a rate limit or a network failure)? */
export function isExpiredSessionError(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  if (!t) return false;
  if (SESSION_RE.test(t)) return true;
  return CODE_RE.test(t) && SUBCODE_RE.test(t);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ZONES: Record<string, number> = { UTC: 0, GMT: 0, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4 };

/** The moment the session ended, from "Session has expired on Wednesday, 14-Oct-26 08:00:00 PDT"; null when not there or in the future. */
export function expiredAtFrom(text: string | null | undefined, now: Date): Date | null {
  const m = /expired on\s+(?:[A-Za-z]+,\s*)?(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([A-Z]{2,4})?/.exec(String(text ?? ''));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const offset = ZONES[m[7] ?? 'UTC'] ?? 0;
  const at = new Date(Date.UTC(year, month, Number(m[1]), Number(m[4]) - offset, Number(m[5]), Number(m[6])));
  return Number.isNaN(at.getTime()) || at.getTime() > now.getTime() ? null : at;
}

/** What the account shows as its verify error: «токен прострочено з 2026-10-14 — перепідключіть акаунт у /app/connections». */
export function expiredErrorText(at: Date): string {
  return `${EXPIRED_PREFIX}${at.toISOString().slice(0, 10)} — перепідключіть акаунт у /app/connections`;
}

/** An account whose token is known to be over (marked by this module, or its expiry passed): the collector slows down for it. */
export function isTokenExpired(a: { verify_error: string | null; token_expires_at: Date | null }, now: Date): boolean {
  return !!a.verify_error?.startsWith(EXPIRED_PREFIX) || (!!a.token_expires_at && new Date(a.token_expires_at).getTime() <= now.getTime());
}

/** For a code-190 Graph error: " (code 190, subcode 463)", so the text checks above can read it ("" for any other error). */
export function graphCodeSuffix(err: unknown): string {
  const e = (err as { response?: { data?: { error?: { code?: number; error_subcode?: number } } } } | null)?.response?.data?.error;
  return e?.code === 190 ? ` (code 190${e.error_subcode != null ? `, subcode ${e.error_subcode}` : ''})` : '';
}
