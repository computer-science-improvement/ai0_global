// Test doubles for the auth module (spec 028): in-memory session/event stores
// and a SessionService wired to them with a movable clock.
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { SessionService } from '../session.service';
import { AuthService } from '../auth.service';
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
  async recentLogins() { return []; }
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

/** AuthService over the in-memory stores. */
export function makeAuth(env: Record<string, string | undefined> = {}) {
  const s = makeSessions(env as Record<string, string>);
  const config = { get: (k: string) => env[k] } as any;
  const auth = new AuthService(config, s.svc, s.events as any);
  return { ...s, auth, config };
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
