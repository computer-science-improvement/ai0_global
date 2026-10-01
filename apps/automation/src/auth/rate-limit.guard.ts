import { CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

export interface RateLimitOptions {
  /** Max accepted requests per key inside the window. Default 10. */
  limit?:    number;
  /** Sliding window length in ms. Default 60 000 (1 minute). */
  windowMs?: number;
  /** Clock override for tests. */
  now?:      () => number;
}

/**
 * In-memory sliding-window rate limiter keyed by client IP — guards the login
 * routes against credential brute force. Single-instance service, so a
 * process-local Map is enough (no Redis round-trip on the auth path).
 *
 * Only ACCEPTED requests are recorded: hammering a locked bucket does not
 * push the unlock further out. Client IP is `req.ip`, which main.ts resolves
 * through the private-network proxy chain (host Caddy → dashboard nginx).
 *
 * Used as an instance (`@UseGuards(loginRateLimit)`), not via DI, so the
 * routes that share one instance share one bucket per IP.
 */
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();
  private readonly limit:    number;
  private readonly windowMs: number;
  private readonly now:      () => number;
  private lastSweep = 0;

  constructor(opts: RateLimitOptions = {}) {
    this.limit    = opts.limit    ?? 10;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now      = opts.now      ?? Date.now;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const key: string = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = this.now();
    const cutoff = now - this.windowMs;

    this.sweep(now, cutoff);

    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      throw new HttpException('Too many login attempts — try again in a minute', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop idle buckets at most once per window so the Map can't grow unbounded. */
  private sweep(now: number, cutoff: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, ts] of this.hits) {
      if (ts.length === 0 || ts[ts.length - 1] <= cutoff) this.hits.delete(k);
    }
  }
}
