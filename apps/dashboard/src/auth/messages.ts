/**
 * User-facing text for auth codes (spec 028 FR-007, FR-012). The backend sends
 * stable codes; the wording lives here. No env var names, ever.
 */

/** Login failure codes from the backend, plus `network` / `unknown` from the client. */
export const LOGIN_ERROR_CODES = [
  'bad_token', 'token_login_disabled', 'bad_signature', 'payload_expired', 'not_allowlisted',
  'telegram_login_disabled', 'rate_limited', 'locked_out', 'network', 'unknown',
] as const;

function wait(sec: number | undefined): string {
  if (!sec || sec <= 0) return 'in a moment';
  if (sec < 90) return `in ${Math.ceil(sec)} s`;
  return `in ${Math.ceil(sec / 60)} min`;
}

export function loginErrorMessage(code: string, retryAfterSec?: number): string {
  switch (code) {
    case 'bad_token':               return 'That access token is not valid.';
    case 'token_login_disabled':    return 'Token sign-in is not enabled on this server.';
    case 'bad_signature':           return 'Telegram could not confirm this sign-in. Please try again.';
    case 'payload_expired':         return 'This Telegram sign-in has expired. Please try again.';
    case 'not_allowlisted':         return 'This Telegram account is not allowed to sign in.';
    case 'telegram_login_disabled': return 'Telegram sign-in is not enabled on this server.';
    case 'rate_limited':            return `Too many attempts, try again ${wait(retryAfterSec)}.`;
    case 'locked_out':              return `Too many failed attempts from your network. Try again ${wait(retryAfterSec)}.`;
    case 'network':                 return "Can't reach the server. Check your connection and try again.";
    default:                        return 'Sign-in failed. Please try again.';
  }
}

/** Why the user landed on /login (the `reason` the guard or nginx passed along). */
export function reasonMessage(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'session_expired': return 'Your session expired. Please sign in again.';
    case 'session_revoked': return 'You were signed out from another device.';
    case 'session_legacy':  return 'Please sign in again after the security update.';
    default:                return null;
  }
}

/**
 * Drop `token=…` from a raw search string before an authorization link is
 * submitted, so the secret doesn't stay in the address bar or history. Only the
 * part before `next=` is touched: nginx's raw `next` is the tail and is kept as is.
 */
export function stripTokenParam(searchStr: string): string {
  const s = searchStr.startsWith('?') ? searchStr.slice(1) : searchStr;
  const m = /(?:^|&)next=/.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const tail = m ? s.slice(m.index) : '';
  const kept = head.split('&').filter((p) => p && !/^token(=|$)/.test(p));
  const rest = tail.replace(/^&/, '');
  const out = [...kept, ...(rest ? [rest] : [])].join('&');
  return out ? `?${out}` : '';
}

// ─── Settings → Security ────────────────────────────────────────────────────

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

export const EVENT_LABEL: Record<string, { label: string; tone: Tone }> = {
  login_ok:     { label: 'Signed in',         tone: 'success' },
  login_failed: { label: 'Failed sign-in',    tone: 'warning' },
  rate_limited: { label: 'Rate limited',      tone: 'warning' },
  locked_out:   { label: 'Locked out',        tone: 'danger' },
  logout:       { label: 'Signed out',        tone: 'neutral' },
  revoked:      { label: 'Session revoked',   tone: 'neutral' },
  revoke_all:   { label: 'Sessions revoked',  tone: 'neutral' },
  expired:      { label: 'Session ended',     tone: 'neutral' },
};

const CODE_LABEL: Record<string, string> = {
  bad_token: 'wrong token', token_login_disabled: 'token sign-in off', bad_signature: 'bad Telegram signature',
  payload_expired: 'Telegram data too old', not_allowlisted: 'account not allowed', telegram_login_disabled: 'Telegram sign-in off',
  rate_limited: 'too many attempts', locked_out: 'network locked for an hour',
  session_expired: 'expired', session_revoked: 'revoked', session_legacy: 'pre-update cookie',
  others: 'all other sessions', include_current: 'all sessions',
};

export function codeLabel(code: string | null | undefined): string {
  if (!code) return '';
  return CODE_LABEL[code] ?? code.replace(/_/g, ' ');
}

export const METHOD_LABEL: Record<string, string> = {
  token: 'Access token', telegram: 'Telegram', link: 'Sign-in link',
};
