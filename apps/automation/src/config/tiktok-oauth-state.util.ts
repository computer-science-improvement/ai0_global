// Signed, stateless OAuth `state` for CSRF — HMAC-SHA256, no storage. `nowMs` is
// passed in so expiry is deterministic and unit-testable.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Token `exp.nonce.sig` where sig = HMAC-SHA256(secret, `exp.nonce`). */
export function signState(secret: string, nowMs: number, ttlMs: number = DEFAULT_TTL_MS): string {
  const exp = nowMs + ttlMs;
  const nonce = randomBytes(9).toString('base64url');
  const payload = `${exp}.${nonce}`;
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * True iff the signature verifies AND exp > nowMs. Never throws.
 * NOTE: this is a TTL-bounded bearer token, NOT single-use — the nonce only adds
 * entropy and is not tracked, so a captured state replays within its TTL. That is
 * acceptable here: the OAuth `code` is the single-use secret (TikTok invalidates it
 * after one exchange), and state only proves the browser started the flow.
 */
export function verifyState(secret: string, token: string, nowMs: number): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  const expected = sign(secret, `${expStr}.${nonce}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
