import type { SessionMethod } from './auth-sessions.repository';

/** Who is calling: the Telegram user (or the token "Operator", sub 0). */
export interface JwtPayload {
  sub: number;
  username?: string;
  firstName: string;
}

/** How a request authenticated (spec 028 FR-003). */
export type AuthMethod = 'bearer' | 'session' | 'dev';

/** 401 body codes. `bad_token` = a Bearer token was presented and is wrong. */
export type AuthFailCode = 'no_credentials' | 'bad_token' | 'session_expired' | 'session_revoked' | 'session_legacy';

export interface AuthContext {
  method:         AuthMethod;
  identity:       JwtPayload;
  /** Session id (cookie logins only). */
  sid?:           string;
  sessionMethod?: SessionMethod;
  expiresAt?:     Date;
  /** A renewed session JWT the caller must send back as the cookie. */
  renewToken?:    string;
  /** The session DB was unreachable; accepted on the strength of an unexpired JWT. */
  degraded?:      boolean;
}

export type AuthResult =
  | ({ ok: true } & AuthContext)
  | { ok: false; code: AuthFailCode; sid?: string }
  | { ok: false; code: 'unavailable' };

/** Login error codes (FR-007), returned as `{code, message, retryAfterSec?}`. */
export type LoginErrorCode =
  | 'bad_token' | 'token_login_disabled'
  | 'bad_signature' | 'payload_expired' | 'not_allowlisted' | 'telegram_login_disabled'
  | 'rate_limited' | 'locked_out';

export interface AuthenticatedRequest {
  user?: JwtPayload;
  auth?: AuthContext;
}
