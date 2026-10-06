import { randomBytes } from 'crypto';

/**
 * Login brute-force limiter (spec 028 FR-008), shared by both login routes.
 *
 *  - Sliding window: a ZSET `auth:rl:<ip>` of accepted attempts, 10 per minute.
 *    Only ACCEPTED attempts are recorded, so hammering a full window does not
 *    push the unlock further out.
 *  - Failure lockout: `auth:fail:<ip>` counts failed logins per hour; at 20 the
 *    IP gets `auth:lock:<ip>` for an hour (`locked_out`).
 *  - Global burst: `auth:fail:global` counts failures from every IP; reaching 50
 *    in an hour raises ONE owner alert and locks nobody out (others must not be
 *    able to lock the owner out).
 *
 * Redis is the shared ioredis client. That client queues commands forever while
 * disconnected (`maxRetriesPerRequest: null`), so a client that is not `ready`,
 * an error or a slow reply (> 500 ms) switches the call to an in-memory copy of
 * the same rules, with a warning. Never fail-open.
 *
 * Client IP is `req.ip`, which main.ts resolves through the private-network
 * proxy chain (host Caddy → dashboard nginx).
 */

/** The ioredis subset the limiter uses (a fake implements it in tests). */
export interface LimiterRedis {
  status?: string;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, sec: number): Promise<unknown>;
  set(key: string, value: string, ex: 'EX', sec: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
}

export interface LimiterOptions {
  /** Accepted attempts per IP inside the window. Default 10. */
  limit?:            number;
  windowMs?:         number;
  /** Failed logins per IP per `failWindowSec` before a lockout. Default 20 / 1 h. */
  failLimit?:        number;
  failWindowSec?:    number;
  lockSec?:          number;
  /** Failures from all IPs per `globalWindowSec` that raise the owner alert. Default 50 / 1 h. */
  globalFailLimit?:  number;
  globalWindowSec?:  number;
  redisTimeoutMs?:   number;
  now?:              () => number;
  warn?:             (msg: string) => void;
}

export type LimitVerdict =
  | { ok: true }
  | { ok: false; code: 'rate_limited' | 'locked_out'; retryAfterSec: number };

export interface FailureOutcome {
  /** This failure locked the IP out. */
  lockedNow:   boolean;
  /** This failure reached the global burst threshold (true once per window). */
  globalBurst: boolean;
}

const K = {
  window: (ip: string) => `auth:rl:${ip}`,
  fail:   (ip: string) => `auth:fail:${ip}`,
  lock:   (ip: string) => `auth:lock:${ip}`,
  global: 'auth:fail:global',
};

export class LoginLimiter {
  private readonly o: Required<Omit<LimiterOptions, 'warn'>>;
  private readonly warnFn: (msg: string) => void;
  private lastWarn = 0;

  // In-memory fallback state (same rules as the Redis keys).
  private readonly hits    = new Map<string, number[]>();
  private readonly fails   = new Map<string, { count: number; resetAt: number }>();
  private readonly locks   = new Map<string, number>();
  private global = { count: 0, resetAt: 0 };
  private lastSweep = 0;

  constructor(private readonly redis: LimiterRedis | null, opts: LimiterOptions = {}) {
    this.o = {
      limit:           opts.limit           ?? 10,
      windowMs:        opts.windowMs        ?? 60_000,
      failLimit:       opts.failLimit       ?? 20,
      failWindowSec:   opts.failWindowSec   ?? 3600,
      lockSec:         opts.lockSec         ?? 3600,
      globalFailLimit: opts.globalFailLimit ?? 50,
      globalWindowSec: opts.globalWindowSec ?? 3600,
      redisTimeoutMs:  opts.redisTimeoutMs  ?? 500,
      now:             opts.now             ?? Date.now,
    };
    this.warnFn = opts.warn ?? (() => undefined);
  }

  /** Check the lock and the window, and record this attempt when it is accepted. */
  async hit(ip: string): Promise<LimitVerdict> {
    return this.viaRedis((r) => this.hitRedis(r, ip), () => this.hitMemory(ip));
  }

  /** Count a failed login (per IP and globally). */
  async fail(ip: string): Promise<FailureOutcome> {
    return this.viaRedis((r) => this.failRedis(r, ip), () => this.failMemory(ip));
  }

  // ─── Redis ────────────────────────────────────────────────────────────────

  private async hitRedis(r: LimiterRedis, ip: string): Promise<LimitVerdict> {
    const lockTtl = await r.ttl(K.lock(ip));
    if (lockTtl > 0 || lockTtl === -1) {
      return { ok: false, code: 'locked_out', retryAfterSec: lockTtl > 0 ? lockTtl : this.o.lockSec };
    }
    const now = this.o.now();
    const key = K.window(ip);
    await r.zremrangebyscore(key, 0, now - this.o.windowMs);
    if (await r.zcard(key) >= this.o.limit) {
      const [, oldest] = await r.zrange(key, 0, 0, 'WITHSCORES');
      return { ok: false, code: 'rate_limited', retryAfterSec: this.retryAfter(Number(oldest ?? now), now) };
    }
    await r.zadd(key, now, `${now}-${randomBytes(4).toString('hex')}`);
    await r.pexpire(key, this.o.windowMs);
    return { ok: true };
  }

  private async failRedis(r: LimiterRedis, ip: string): Promise<FailureOutcome> {
    const n = await r.incr(K.fail(ip));
    if (n === 1) await r.expire(K.fail(ip), this.o.failWindowSec);
    let lockedNow = false;
    if (n >= this.o.failLimit) {
      await r.set(K.lock(ip), '1', 'EX', this.o.lockSec);
      await r.del(K.fail(ip));
      lockedNow = true;
    }
    const g = await r.incr(K.global);
    if (g === 1) await r.expire(K.global, this.o.globalWindowSec);
    return { lockedNow, globalBurst: g === this.o.globalFailLimit };
  }

  // ─── In-memory fallback ───────────────────────────────────────────────────

  private hitMemory(ip: string): LimitVerdict {
    const now = this.o.now();
    this.sweep(now);
    const until = this.locks.get(ip);
    if (until && until > now) return { ok: false, code: 'locked_out', retryAfterSec: Math.ceil((until - now) / 1000) };
    const cutoff = now - this.o.windowMs;
    const recent = (this.hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.o.limit) {
      this.hits.set(ip, recent);
      return { ok: false, code: 'rate_limited', retryAfterSec: this.retryAfter(recent[0], now) };
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return { ok: true };
  }

  private failMemory(ip: string): FailureOutcome {
    const now = this.o.now();
    const f = this.fails.get(ip);
    const cur = f && f.resetAt > now ? f : { count: 0, resetAt: now + this.o.failWindowSec * 1000 };
    cur.count++;
    let lockedNow = false;
    if (cur.count >= this.o.failLimit) {
      this.locks.set(ip, now + this.o.lockSec * 1000);
      this.fails.delete(ip);
      lockedNow = true;
    } else {
      this.fails.set(ip, cur);
    }
    if (this.global.resetAt <= now) this.global = { count: 0, resetAt: now + this.o.globalWindowSec * 1000 };
    this.global.count++;
    return { lockedNow, globalBurst: this.global.count === this.o.globalFailLimit };
  }

  /** Drop idle entries at most once per window so the Maps can't grow unbounded. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.o.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.o.windowMs;
    for (const [k, ts] of this.hits) if (ts.length === 0 || ts[ts.length - 1] <= cutoff) this.hits.delete(k);
    for (const [k, f] of this.fails) if (f.resetAt <= now) this.fails.delete(k);
    for (const [k, until] of this.locks) if (until <= now) this.locks.delete(k);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private retryAfter(oldestMs: number, now: number): number {
    return Math.max(1, Math.ceil((oldestMs + this.o.windowMs - now) / 1000));
  }

  private async viaRedis<T>(redisFn: (r: LimiterRedis) => Promise<T>, memoryFn: () => T): Promise<T> {
    const r = this.redis;
    if (!r || (r.status !== undefined && r.status !== 'ready')) {
      this.warn(`Redis ${r ? `not ready (${r.status})` : 'not configured'}; login limiter using in-memory window`);
      return memoryFn();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        redisFn(r),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${this.o.redisTimeoutMs} ms`)), this.o.redisTimeoutMs);
        }),
      ]);
    } catch (err) {
      this.warn(`Redis error (${(err as Error).message}); login limiter using in-memory window`);
      return memoryFn();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** At most one warning a minute. */
  private warn(msg: string): void {
    const now = this.o.now();
    if (now - this.lastWarn < 60_000) return;
    this.lastWarn = now;
    this.warnFn(msg);
  }
}
