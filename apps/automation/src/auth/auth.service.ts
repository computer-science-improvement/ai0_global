import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'crypto';
import { TelegramLoginDto } from './telegram-login.dto';
import { AuthResult, JwtPayload, LoginErrorCode } from './auth.types';
import { safeEqual } from '../common/crypto/safe-equal';
import { SessionService } from './session.service';
import { AuthEventInput, AuthEventsRepository } from './auth-events.repository';
import { AuthSessionRow, SessionMethod } from './auth-sessions.repository';
import { SESSION_COOKIE } from './auth-cookie';
import { ipPrefix, uaFamily } from './client-info';
import { LoginLimiter } from './login-limiter';

/** Sends a plain-text alert to the owner (TelegramNotifier.notifyAlert, or a no-op). */
export type AuthAlert = (text: string) => Promise<void>;
export const AUTH_ALERT = 'AUTH_ALERT';

/** A device is "known" if a login from the same network + browser family succeeded this recently. */
const NEW_DEVICE_LOOKBACK_DAYS = 30;

/** Who is logging in from where — the audit and the session row need it. */
export interface ClientInfo { ip: string | null; userAgent: string | null }

/** Identity of the shared-token login (no Telegram user behind it). */
export const TOKEN_IDENTITY: JwtPayload = { sub: 0, username: 'token', firstName: 'Operator' };
/** Identity reported for the explicit local no-auth bypass. */
export const DEV_IDENTITY: JwtPayload = { sub: 0, username: 'dev', firstName: 'Dev' };

/**
 * A login failure with a stable `code` (FR-007). The body is `{statusCode, code,
 * message}`; the dashboard maps the code to its own text, so messages never
 * name env vars.
 */
export function loginError(code: LoginErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (code) {
    case 'token_login_disabled':
    case 'telegram_login_disabled':
    case 'not_allowlisted':
      return new ForbiddenException({ statusCode: 403, ...body });
    case 'rate_limited':
    case 'locked_out':
      return new HttpException({ statusCode: 429, ...body }, HttpStatus.TOO_MANY_REQUESTS);
    default:
      return new UnauthorizedException({ statusCode: 401, ...body });
  }
}

/** A 429 from the limiter: `{code, message, retryAfterSec}` (the controller adds `Retry-After`). */
export function limitError(code: 'rate_limited' | 'locked_out', retryAfterSec: number): HttpException {
  const message = code === 'locked_out' ? 'Too many failed sign-in attempts' : 'Too many sign-in attempts';
  return new HttpException({ statusCode: 429, code, message, retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
}

export function retryAfterOf(err: unknown): number | null {
  if (!(err instanceof HttpException)) return null;
  const r = err.getResponse() as any;
  return r && typeof r.retryAfterSec === 'number' ? r.retryAfterSec : null;
}

export function loginErrorCode(err: unknown): LoginErrorCode | null {
  if (!(err instanceof HttpException)) return null;
  const r = err.getResponse();
  return r && typeof r === 'object' && typeof (r as any).code === 'string' ? (r as any).code : null;
}

export interface SessionView {
  id: string; method: SessionMethod; device: string; userAgent: string | null; ip: string | null;
  createdAt: Date; lastSeenAt: Date; expiresAt: Date; current: boolean;
}

export interface AuthEventView {
  id: number; at: Date; kind: string; method: string | null; code: string | null;
  ip: string | null; device: string | null; sessionId: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Last rate_limited / locked_out audit row per IP: one per minute is enough. */
  private readonly limitAudited = new Map<string, number>();
  /** The last new-device check (fire-and-forget; tests await it). */
  lastDeviceCheck: Promise<void> = Promise.resolve();

  constructor(
    private readonly config:   ConfigService,
    private readonly sessions: SessionService,
    private readonly events:   AuthEventsRepository,
    private readonly limiter:  LoginLimiter,
    @Inject(AUTH_ALERT) private readonly alert: AuthAlert,
  ) {}

  get production(): boolean { return this.config.get<string>('NODE_ENV') === 'production'; }
  get cookieMaxAgeMs(): number { return this.sessions.cookieMaxAgeMs; }

  // ─── Login ────────────────────────────────────────────────────────────────

  /**
   * Rate-limit, check the credentials, open a session and audit the attempt.
   * Throws a coded HttpException (`loginError` / `limitError`) on failure.
   */
  async login(
    method: SessionMethod, input: TelegramLoginDto | string, client: ClientInfo,
  ): Promise<{ token: string; session: AuthSessionRow; identity: JwtPayload }> {
    const ipKey = client.ip ?? 'unknown';
    const verdict = await this.limiter.hit(ipKey);
    if (!verdict.ok) {
      await this.auditLimit(verdict.code, method, client);
      throw limitError(verdict.code, verdict.retryAfterSec);
    }

    let identity: JwtPayload;
    try {
      identity = method === 'telegram'
        ? this.checkTelegram(input as TelegramLoginDto)
        : this.checkToken(input as string);
    } catch (err) {
      await this.audit({ kind: 'login_failed', method, code: loginErrorCode(err) ?? 'error', ...client });
      await this.countFailure(ipKey, method, client);
      throw err;
    }
    const { token, session } = await this.sessions.issue({
      method, subjectId: identity.sub, firstName: identity.firstName, username: identity.username ?? null, ...client,
    });
    await this.audit({ kind: 'login_ok', method, subjectId: identity.sub, sessionId: session.id, ...client });
    this.lastDeviceCheck = this.checkNewDevice(session, client).catch((err) =>
      this.logger.warn(`new-device check failed: ${(err as Error).message}`));
    return { token, session, identity };
  }

  private async countFailure(ipKey: string, method: SessionMethod, client: ClientInfo): Promise<void> {
    const out = await this.limiter.fail(ipKey);
    if (out.lockedNow) {
      this.limitAudited.set(`locked_out:${ipKey}`, Date.now());
      await this.audit({ kind: 'locked_out', method, code: 'locked_out', ...client });
    }
    if (out.globalBurst) {
      await this.notify(
        '⚠️ ai0 dashboard: 50 failed sign-in attempts in the last hour (all IPs together).\n'
        + 'Nobody was locked out by this; single IPs are locked after 20 failures.\n'
        + 'Review: Settings → Security → Recent events.');
    }
  }

  /** One rate_limited / locked_out row per IP per minute, so a flood can't flood the table. */
  private async auditLimit(code: 'rate_limited' | 'locked_out', method: SessionMethod, client: ClientInfo): Promise<void> {
    const key = `${code}:${client.ip ?? 'unknown'}`;
    const now = Date.now();
    if (now - (this.limitAudited.get(key) ?? 0) < 60_000) return;
    this.limitAudited.set(key, now);
    if (this.limitAudited.size > 5000) this.limitAudited.clear();
    await this.audit({ kind: code, method, code, ...client });
  }

  /**
   * FR-009: ping the owner when a login comes from a device not seen in the last
   * 30 days (same IPv4 /24 or IPv6 /48 AND the same browser + OS family).
   */
  private async checkNewDevice(session: AuthSessionRow, client: ClientInfo): Promise<void> {
    const prefix = ipPrefix(client.ip);
    const family = uaFamily(client.userAgent);
    const recent = await this.events.recentLogins(NEW_DEVICE_LOOKBACK_DAYS, session.id);
    if (recent.some((r) => ipPrefix(r.ip) === prefix && uaFamily(r.userAgent) === family)) return;
    await this.notify(
      `🔐 New sign-in to the ai0 dashboard\n`
      + `Method: ${session.method}\nIP: ${client.ip ?? 'unknown'}\nDevice: ${family}\n`
      + `Not you? Settings → Security → Sign out everywhere.`);
  }

  private async notify(text: string): Promise<void> {
    try { await this.alert(text); }
    catch (err) { this.logger.warn(`auth alert failed: ${(err as Error).message}`); }
  }

  /** Telegram Login Widget payload → identity (signature, age, allowlist). */
  checkTelegram(input: TelegramLoginDto): JwtPayload {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    if (!botToken) {
      this.logger.warn('Telegram login refused: TELEGRAM_BOT_TOKEN is not set');
      throw loginError('telegram_login_disabled', 'Telegram sign-in is not enabled on this server');
    }

    const expectedHash = this.computeHash(input, botToken);
    if (!safeEqual(expectedHash, input.hash)) throw loginError('bad_signature', 'Telegram signature check failed');

    const ageSec = Math.floor(Date.now() / 1000) - input.auth_date;
    if (ageSec > 86_400) throw loginError('payload_expired', 'Telegram sign-in data is too old');

    // FAILS CLOSED: an empty/missing allowlist disables Telegram login entirely.
    // (It used to mean "anyone with a valid widget signature" — i.e. any
    // Telegram user became admin when the env var was forgotten.)
    const allow = (this.config.get<string>('TRACKING_ALLOWED_TG_USER_IDS') ?? '')
      .split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    if (allow.length === 0) {
      this.logger.warn('Telegram login refused: TRACKING_ALLOWED_TG_USER_IDS is empty');
      throw loginError('telegram_login_disabled', 'Telegram sign-in is not enabled on this server');
    }
    if (!allow.includes(input.id)) throw loginError('not_allowlisted', 'This Telegram account is not allowed to sign in');

    return { sub: input.id, username: input.username, firstName: input.first_name };
  }

  /**
   * Shared-token login — compares a pasted token against the TRACKING_TOKEN env
   * secret (constant-time). Lets an operator authenticate on a plain HTTP box
   * with no domain / no Telegram widget.
   */
  checkToken(provided: string): JwtPayload {
    const expected = this.config.get<string>('TRACKING_TOKEN') ?? '';
    if (!expected) {
      this.logger.warn('Token login refused: TRACKING_TOKEN is not set');
      throw loginError('token_login_disabled', 'Token sign-in is not enabled on this server');
    }
    if (!safeEqual(provided, expected)) throw loginError('bad_token', 'Invalid token');
    return { ...TOKEN_IDENTITY };
  }

  private computeHash(input: TelegramLoginDto, botToken: string): string {
    const dataCheckString = (Object.keys(input) as (keyof TelegramLoginDto)[])
      .filter((k) => k !== 'hash' && input[k] !== undefined)
      .sort()
      .map((k) => `${k}=${input[k]}`)
      .join('\n');
    const secret = createHash('sha256').update(botToken).digest();
    return createHmac('sha256', secret).update(dataCheckString).digest('hex');
  }

  // ─── Authenticate (FR-003) ────────────────────────────────────────────────

  /**
   * The ONE authenticator behind TrackingAuthGuard, `/auth/me` and `/auth/check`:
   * Bearer TRACKING_TOKEN (constant-time) → session cookie → the explicit local
   * dev bypass. `readOnly` (nginx check) never writes or renews.
   */
  async authenticate(req: any, opts: { readOnly?: boolean } = {}): Promise<AuthResult> {
    // 1. Bearer token (scripts, the editor harness). Creates no session.
    const expected = this.config.get<string>('TRACKING_TOKEN') ?? '';
    const header = req.headers?.['authorization'];
    const bearer = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (expected && bearer && safeEqual(bearer, expected)) {
      return { ok: true, method: 'bearer', identity: { ...TOKEN_IDENTITY } };
    }

    // 2. Session cookie (the dashboard).
    const cookie: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof cookie === 'string' && cookie) {
      const r = await this.sessions.verify(cookie, opts);
      if (r.ok) {
        const c = r.claims;
        return {
          ok: true, method: 'session', sid: r.session.id, sessionMethod: r.session.method, expiresAt: r.expiresAt,
          identity: { sub: r.session.subjectId, firstName: r.session.firstName ?? c.firstName, ...(r.session.username ? { username: r.session.username } : {}) },
          ...(r.renewToken ? { renewToken: r.renewToken } : {}),
        };
      }
      if (r.code === 'unavailable') {
        // DB outage: an unexpired JWT is still trusted, so an outage is not a logout.
        if (!r.jwtUnexpired) return { ok: false, code: 'unavailable' };
        const c = r.claims;
        return {
          ok: true, method: 'session', sid: c.sid, sessionMethod: c.method, degraded: true,
          identity: { sub: c.sub, firstName: c.firstName, ...(c.username ? { username: c.username } : {}) },
        };
      }
      return { ok: false, code: r.code, ...(r.sid ? { sid: r.sid } : {}) };
    }

    // 3. Local bypass — EXPLICIT opt-in only. Never keyed off a missing secret
    // (that turns a forgotten env var into a wide-open admin API). Requires
    // ALLOW_NO_AUTH=true and a non-production NODE_ENV, and only when no
    // credentials were presented at all.
    const allowNoAuth =
      this.config.get<string>('ALLOW_NO_AUTH') === 'true' &&
      this.config.get<string>('NODE_ENV') !== 'production';
    if (allowNoAuth && !expected) return { ok: true, method: 'dev', identity: { ...DEV_IDENTITY } };

    return { ok: false, code: bearer ? 'bad_token' : 'no_credentials' };
  }

  // ─── Sessions (FR-010, FR-014) ────────────────────────────────────────────

  /** Logout: revoke the cookie's session (if it still has one) and audit it. */
  async logout(req: any, client: ClientInfo): Promise<void> {
    const cookie: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof cookie !== 'string' || !cookie) return;
    const r = await this.sessions.verify(cookie, { readOnly: true });
    const sid = r.ok ? r.session.id : r.code === 'unavailable' ? r.claims.sid : null;
    if (!sid) return;
    if (await this.sessions.revoke(sid, 'logout')) {
      await this.audit({ kind: 'logout', method: r.ok ? r.session.method : null, sessionId: sid, subjectId: r.ok ? r.session.subjectId : null, ...client });
    }
  }

  /** A cookie that no longer opens a session: audited once, as the browser then drops it. */
  async auditDeadCookie(code: string, sid: string | undefined, client: ClientInfo): Promise<void> {
    await this.audit({ kind: 'expired', code, sessionId: sid ?? null, ...client });
  }

  async listSessions(currentSid: string | undefined): Promise<SessionView[]> {
    const rows = await this.sessions.listLive();
    return rows.map((r) => ({
      id: r.id, method: r.method, device: uaFamily(r.userAgent), userAgent: r.userAgent, ip: r.ip,
      createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, expiresAt: this.sessions.expiresAt(r), current: r.id === currentSid,
    }));
  }

  /** Revoke one session. Returns whether it was the caller's own (the cookie must then be cleared). */
  async revokeSession(id: string, currentSid: string | undefined, client: ClientInfo): Promise<{ revoked: boolean; current: boolean }> {
    const revoked = await this.sessions.revoke(id, 'revoked');
    if (revoked) await this.audit({ kind: 'revoked', sessionId: id, ...client });
    return { revoked, current: id === currentSid };
  }

  /** Sign out other sessions (or all of them with `includeCurrent`). Bearer callers have no session: all go. */
  async revokeAll(currentSid: string | undefined, includeCurrent: boolean, client: ClientInfo): Promise<{ revoked: number; current: boolean }> {
    const except = includeCurrent ? null : currentSid ?? null;
    const ids = await this.sessions.revokeAll(except, 'revoke_all');
    await this.audit({ kind: 'revoke_all', code: includeCurrent ? 'include_current' : 'others', sessionId: currentSid ?? null, ...client });
    return { revoked: ids.length, current: includeCurrent && !!currentSid };
  }

  async recentEvents(limit: number): Promise<AuthEventView[]> {
    const rows = await this.events.recent(limit);
    return rows.map((e) => ({
      id: e.id, at: e.at, kind: e.kind, method: e.method, code: e.code, ip: e.ip,
      device: e.userAgent ? uaFamily(e.userAgent) : null, sessionId: e.sessionId,
    }));
  }

  /** Audit writes never break the request they describe. */
  async audit(e: AuthEventInput): Promise<void> {
    try { await this.events.record(e); }
    catch (err) { this.logger.warn(`auth audit write failed (${e.kind}): ${(err as Error).message}`); }
  }
}
