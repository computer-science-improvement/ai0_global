// Test doubles for the auth module (spec 028): in-memory session/event stores
// and a SessionService wired to them with a movable clock.
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { SessionService } from '../session.service';
import { AuthService } from '../auth.service';
import { LoginLimiter, LimiterOptions } from '../login-limiter';
import type { AuthSessionRow, NewSession } from '../auth-sessions.repository';

/** In-memory auth_sessions with call counters. */
export class FakeSessionsRepo {
  rows = new Map<string, AuthSessionRow>();
  finds = 0;
  touches = 0;
  failReads = false;
  now = () => Date.now();
  async create(s: NewSession): Promise<AuthSessionRow> {
    const t = new Date(this.now());
    const row: AuthSessionRow = { id: randomUUID(), ...s, createdAt: t, lastSeenAt: t, revokedAt: null, revokedReason: null };
    this.rows.set(row.id, row);
    return { ...row };
  }
  async findById(id: string) {
    this.finds++;
    if (this.failReads) throw new Error('db down');
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async touch(id: string, at: Date) { this.touches++; const r = this.rows.get(id); if (r && !r.revokedAt) r.lastSeenAt = at; }
  async revoke(id: string, reason: string) {
    const r = this.rows.get(id);
    if (!r || r.revokedAt) return false;
    r.revokedAt = new Date(this.now()); r.revokedReason = reason; return true;
  }
  async revokeAll(exceptId: string | null, reason: string) {
    const ids: string[] = [];
    for (const r of this.rows.values()) {
      if (r.revokedAt || r.id === exceptId) continue;
      r.revokedAt = new Date(this.now()); r.revokedReason = reason; ids.push(r.id);
    }
    return ids;
  }
  async listLive() { return [...this.rows.values()].filter((r) => !r.revokedAt); }
  purgeArgs: unknown[] = [];
  async purgeDead(w: unknown, grace: number) { this.purgeArgs = [w, grace]; return 2; }
}

export class FakeEventsRepo {
  events: any[] = [];
  purgedDays: number | null = null;
  async record(e: any) { this.events.push(e); }
  async recent(limit: number) { return this.events.slice(-limit).reverse(); }
  async recentLogins(_days: number, exclude: string | null): Promise<{ ip: string | null; userAgent: string | null }[]> {
    return this.events.filter((e) => e.kind === 'login_ok' && e.sessionId !== exclude).map((e) => ({ ip: e.ip, userAgent: e.userAgent }));
  }
  async purgeOlderThan(days: number) { this.purgedDays = days; return 5; }
}

export const TEST_JWT_SECRET = 'test-secret';

export function makeSessions(env: Record<string, string> = {}) {
  const repo = new FakeSessionsRepo();
  const events = new FakeEventsRepo();
  const jwt = new JwtService({ secret: TEST_JWT_SECRET });
  const config = { get: (k: string) => env[k] } as any;
  const svc = new SessionService(repo as any, events as any, jwt, config);
  let offset = 0;
  svc.clock = () => Date.now() + offset;
  repo.now = svc.clock;
  return { svc, repo, events, jwt, advance: (ms: number) => { offset += ms; } };
}

/**
 * The ioredis subset LoginLimiter uses, in memory, with key expiry on a movable
 * clock. `mode` simulates an outage: 'throw' rejects every command, 'hang'
 * never answers (ioredis queues while disconnected).
 */
export class FakeRedis {
  status = 'ready';
  mode: 'ok' | 'throw' | 'hang' = 'ok';
  calls = 0;
  private z = new Map<string, { score: number; member: string }[]>();
  private kv = new Map<string, string>();
  private exp = new Map<string, number>();
  constructor(public now: () => number = Date.now) {}

  private async op<T>(fn: () => T): Promise<T> {
    this.calls++;
    if (this.mode === 'throw') throw new Error('ECONNREFUSED');
    if (this.mode === 'hang') return new Promise<T>(() => undefined);
    return fn();
  }
  private live(key: string): boolean {
    const e = this.exp.get(key);
    if (e !== undefined && e <= this.now()) { this.z.delete(key); this.kv.delete(key); this.exp.delete(key); return false; }
    return this.z.has(key) || this.kv.has(key);
  }
  zremrangebyscore(key: string, min: number | string, max: number | string) {
    return this.op(() => {
      if (!this.live(key)) return 0;
      const before = this.z.get(key)!.length;
      this.z.set(key, this.z.get(key)!.filter((e) => e.score < Number(min) || e.score > Number(max)));
      return before - this.z.get(key)!.length;
    });
  }
  zcard(key: string) { return this.op(() => (this.live(key) ? this.z.get(key)?.length ?? 0 : 0)); }
  zrange(key: string, start: number, stop: number, _w: 'WITHSCORES') {
    return this.op(() => {
      if (!this.live(key)) return [];
      const s = [...(this.z.get(key) ?? [])].sort((a, b) => a.score - b.score).slice(start, stop + 1);
      return s.flatMap((e) => [e.member, String(e.score)]);
    });
  }
  zadd(key: string, score: number, member: string) {
    return this.op(() => { this.live(key); const l = this.z.get(key) ?? []; l.push({ score, member }); this.z.set(key, l); return 1; });
  }
  pexpire(key: string, ms: number) { return this.op(() => { if (!this.live(key)) return 0; this.exp.set(key, this.now() + ms); return 1; }); }
  expire(key: string, sec: number) { return this.op(() => { if (!this.live(key)) return 0; this.exp.set(key, this.now() + sec * 1000); return 1; }); }
  incr(key: string) {
    return this.op(() => { const v = (this.live(key) ? Number(this.kv.get(key)) : 0) + 1; this.kv.set(key, String(v)); return v; });
  }
  set(key: string, value: string, _ex: 'EX', sec: number) {
    return this.op(() => { this.kv.set(key, value); this.exp.set(key, this.now() + sec * 1000); return 'OK'; });
  }
  ttl(key: string) {
    return this.op(() => {
      if (!this.live(key)) return -2;
      const e = this.exp.get(key);
      return e === undefined ? -1 : Math.ceil((e - this.now()) / 1000);
    });
  }
  del(key: string) { return this.op(() => { const had = this.live(key); this.z.delete(key); this.kv.delete(key); this.exp.delete(key); return had ? 1 : 0; }); }
}

/** AuthService over the in-memory stores, a fake Redis limiter and a recording alert. */
export function makeAuth(env: Record<string, string | undefined> = {}, limiterOpts: LimiterOptions = {}) {
  const s = makeSessions(env as Record<string, string>);
  const config = { get: (k: string) => env[k] } as any;
  const redis = new FakeRedis(s.svc.clock);
  const limiter = new LoginLimiter(redis, { now: s.svc.clock, ...limiterOpts });
  const alerts: string[] = [];
  const auth = new AuthService(config, s.svc, s.events as any, limiter, async (t) => { alerts.push(t); });
  return { ...s, auth, config, redis, limiter, alerts };
}

/** A minimal express-like request. */
export function fakeReq(o: { cookie?: string; bearer?: string; ip?: string; ua?: string } = {}): any {
  return {
    headers: { ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(o.ua ? { 'user-agent': o.ua } : {}) },
    cookies: o.cookie ? { tracking_jwt: o.cookie } : {},
    ip: o.ip ?? '1.2.3.4',
  };
}

/** A minimal express-like response that records what was sent. */
export function fakeRes() {
  const res: any = {
    statusCode: 200, headers: {} as Record<string, string>, ended: false,
    cookies: [] as { name: string; value: string; opts: any }[], cleared: [] as { name: string; opts: any }[],
    setHeader(k: string, v: string) { res.headers[k] = v; return res; },
    cookie(name: string, value: string, opts: any) { res.cookies.push({ name, value, opts }); return res; },
    clearCookie(name: string, opts: any) { res.cleared.push({ name, opts }); return res; },
    status(c: number) { res.statusCode = c; return res; },
    end() { res.ended = true; return res; },
  };
  return res;
}
