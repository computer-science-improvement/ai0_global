import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Cron } from '@nestjs/schedule';
import { AuthSessionRow, AuthSessionsRepository, NewSession, SessionMethod } from './auth-sessions.repository';
import { AuthEventsRepository } from './auth-events.repository';

/**
 * Revocable dashboard sessions (spec 028 FR-002).
 *
 * Login inserts an `auth_sessions` row and signs a SHORT JWT that carries the
 * row id (`sid`). The row is the source of truth: a session is valid while it is
 * not revoked, was seen within the idle window and is younger than the absolute
 * cap. The JWT only saves a DB round-trip per request:
 *  - every check reads the row through a 60 s in-process cache (single instance,
 *    001 FR-015), which revoke invalidates synchronously — so a revoke bites on
 *    the very next request;
 *  - past the JWT's half-life (or after it expired, while the row is still within
 *    the idle window) a guarded request re-reads the row from the DB and gets a
 *    fresh token (sliding renewal);
 *  - `last_seen_at` is written at most every 5 minutes.
 *
 * A JWT without `sid` (pre-028 cookie) is `session_legacy`: one re-login.
 * A JWT with a bad signature (e.g. rotated JWT_SECRET) is `session_expired`.
 */

export type SessionFailCode = 'session_expired' | 'session_revoked' | 'session_legacy';

export interface SessionClaims {
  sub:       number;
  sid:       string;
  method:    SessionMethod;
  firstName: string;
  username?: string;
  v:         2;
  iat?:      number;
  exp?:      number;
}

export type SessionCheck =
  | { ok: true; session: AuthSessionRow; claims: SessionClaims; expiresAt: Date; renewToken?: string }
  | { ok: false; code: SessionFailCode; sid?: string }
  /** The DB could not be read; `jwtUnexpired` lets callers degrade instead of logging the user out. */
  | { ok: false; code: 'unavailable'; jwtUnexpired: boolean; claims: SessionClaims };

export interface SessionSettings {
  accessTtlMin:    number;
  idleTtlDays:     number;
  absoluteTtlDays: number;
  eventsRetentionDays: number;
}

/** A positive numeric env var; empty / invalid / ≤ 0 means the default (never 0). */
export function envNumber(env: (k: string) => string | undefined, key: string, def: number): number {
  const v = env(key)?.trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function readSessionSettings(env: (k: string) => string | undefined): SessionSettings {
  return {
    accessTtlMin:        envNumber(env, 'AUTH_ACCESS_TTL_MIN', 60),
    idleTtlDays:         envNumber(env, 'AUTH_IDLE_TTL_DAYS', 7),
    absoluteTtlDays:     envNumber(env, 'AUTH_ABSOLUTE_TTL_DAYS', 30),
    eventsRetentionDays: envNumber(env, 'AUTH_EVENTS_RETENTION_DAYS', 180),
  };
}

const DAY_MS = 86_400_000;
export const SESSION_CACHE_TTL_MS = 60_000;
export const LAST_SEEN_THROTTLE_MS = 5 * 60_000;
/** Dead sessions (revoked / expired) are kept this long for the Security page, then purged. */
export const DEAD_SESSION_GRACE_DAYS = 30;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  readonly settings: SessionSettings;
  /** Clock override for tests. */
  clock: () => number = Date.now;

  private readonly cache = new Map<string, { row: AuthSessionRow; at: number }>();
  /** Bumped by every revoke: a DB read that started before a revoke must not repopulate the cache. */
  private epoch = 0;

  constructor(
    private readonly sessions: AuthSessionsRepository,
    private readonly events:   AuthEventsRepository,
    private readonly jwt:      JwtService,
    config: ConfigService,
  ) {
    this.settings = readSessionSettings((k) => config.get<string>(k) ?? undefined);
  }

  /** Cookie `maxAge`: the idle window (each renewal re-sends the cookie, so it slides). */
  get cookieMaxAgeMs(): number { return this.settings.idleTtlDays * DAY_MS; }

  /** When the session dies if unused: min(last seen + idle, created + absolute cap). */
  expiresAt(row: AuthSessionRow): Date {
    return new Date(Math.min(
      row.lastSeenAt.getTime() + this.settings.idleTtlDays * DAY_MS,
      row.createdAt.getTime() + this.settings.absoluteTtlDays * DAY_MS,
    ));
  }

  private alive(row: AuthSessionRow, now: number): boolean {
    return !row.revokedAt && this.expiresAt(row).getTime() > now;
  }

  async issue(input: NewSession): Promise<{ token: string; session: AuthSessionRow; claims: SessionClaims }> {
    const session = await this.sessions.create(input);
    this.cache.set(session.id, { row: session, at: this.clock() });
    const claims = this.claimsOf(session);
    return { token: await this.sign(claims), session, claims };
  }

  /**
   * Check a session JWT. `readOnly` (the nginx `/auth/check` path) never writes,
   * never renews and reads the DB only on a cache miss.
   */
  async verify(token: string, opts: { readOnly?: boolean } = {}): Promise<SessionCheck> {
    let claims: SessionClaims;
    try {
      claims = await this.jwt.verifyAsync<SessionClaims>(token, { ignoreExpiration: true });
    } catch {
      return { ok: false, code: 'session_expired' };
    }
    if (!claims || typeof claims.sid !== 'string' || claims.v !== 2) return { ok: false, code: 'session_legacy' };

    const now = this.clock();
    const expMs = (claims.exp ?? 0) * 1000;
    const iatMs = (claims.iat ?? 0) * 1000;
    const jwtExpired = now >= expMs;
    const renew = !opts.readOnly && (jwtExpired || now >= iatMs + (expMs - iatMs) / 2);

    let row: AuthSessionRow | null;
    try {
      row = await this.load(claims.sid, renew);
    } catch (err) {
      this.logger.warn(`session lookup failed: ${(err as Error).message}`);
      return { ok: false, code: 'unavailable', jwtUnexpired: !jwtExpired, claims };
    }
    const sid = claims.sid;
    if (!row) return { ok: false, code: 'session_expired', sid };
    if (row.revokedAt) return { ok: false, code: 'session_revoked', sid };
    if (!this.alive(row, now)) return { ok: false, code: 'session_expired', sid };

    if (opts.readOnly) return { ok: true, session: row, claims, expiresAt: this.expiresAt(row) };

    if (now - row.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS) {
      try {
        await this.sessions.touch(row.id, new Date(now));
        row = { ...row, lastSeenAt: new Date(now) };
        this.cache.set(row.id, { row, at: now });
      } catch (err) {
        this.logger.warn(`last_seen update failed: ${(err as Error).message}`);
      }
    }

    const renewToken = renew ? await this.sign(this.claimsOf(row)) : undefined;
    return { ok: true, session: row, claims, expiresAt: this.expiresAt(row), ...(renewToken ? { renewToken } : {}) };
  }

  /** Revoke one session; the cache entry is dropped before this resolves. */
  async revoke(id: string, reason: string): Promise<boolean> {
    try {
      return await this.sessions.revoke(id, reason);
    } finally {
      this.epoch++;
      this.cache.delete(id);
    }
  }

  /** Revoke every live session except `exceptId` (null = all of them). */
  async revokeAll(exceptId: string | null, reason: string): Promise<string[]> {
    try {
      return await this.sessions.revokeAll(exceptId, reason);
    } finally {
      this.epoch++;
      this.cache.clear();
    }
  }

  listLive(): Promise<AuthSessionRow[]> {
    return this.sessions.listLive({ idleDays: this.settings.idleTtlDays, absoluteDays: this.settings.absoluteTtlDays });
  }

  /** Daily: audit events past retention, sessions dead for 30+ days. */
  @Cron('41 3 * * *', { name: 'auth-purge' })
  async purge(): Promise<{ events: number; sessions: number }> {
    try {
      const events = await this.events.purgeOlderThan(this.settings.eventsRetentionDays);
      const sessions = await this.sessions.purgeDead(
        { idleDays: this.settings.idleTtlDays, absoluteDays: this.settings.absoluteTtlDays }, DEAD_SESSION_GRACE_DAYS);
      if (events || sessions) this.logger.log(`auth purge: ${events} events, ${sessions} sessions`);
      return { events, sessions };
    } catch (err) {
      this.logger.warn(`auth purge failed: ${(err as Error).message}`);
      return { events: 0, sessions: 0 };
    }
  }

  private async load(sid: string, fresh: boolean): Promise<AuthSessionRow | null> {
    const now = this.clock();
    const hit = this.cache.get(sid);
    if (!fresh && hit && now - hit.at < SESSION_CACHE_TTL_MS) return hit.row;
    const epoch = this.epoch;
    const row = await this.sessions.findById(sid);
    if (row && epoch === this.epoch) this.cache.set(sid, { row, at: now });
    else this.cache.delete(sid);
    return row;
  }

  private claimsOf(row: AuthSessionRow): SessionClaims {
    return {
      sub: row.subjectId, sid: row.id, method: row.method,
      firstName: row.firstName ?? '', ...(row.username ? { username: row.username } : {}), v: 2,
    };
  }

  private sign(claims: SessionClaims): Promise<string> {
    // iat from our clock (jsonwebtoken derives exp from it), so renewal timing and
    // the half-life check run on one time source.
    const { iat: _iat, exp: _exp, ...payload } = claims;
    return this.jwt.signAsync(
      { ...payload, iat: Math.floor(this.clock() / 1000) },
      { expiresIn: Math.round(this.settings.accessTtlMin * 60) },
    );
  }
}
