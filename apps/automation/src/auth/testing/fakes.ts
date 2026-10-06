// Test doubles for the auth module (spec 028): in-memory session/event stores
// and a SessionService wired to them with a movable clock.
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { SessionService } from '../session.service';
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
