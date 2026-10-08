// apps/automation/src/common/rate-limit/sliding-window-limiter.ts
// A small in-process sliding-window limiter for public endpoints (spec 026: the
// landing CTA beacon at 60/min and lead intake at 5/hour per client).
//
// The service runs as a single replica (owner decision: single-instance), so an
// in-memory window is enough. Callers pass a hashed key, never a raw IP, so not
// even process memory holds client addresses. The map is bounded: when it is full,
// the stalest keys are dropped first (a flood of distinct keys cannot grow it).

export interface RateLimitDecision { ok: boolean; retryAfterSec: number }

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Count one hit for `key`; `ok: false` when the key already used its budget in the window. */
  hit(key: string): RateLimitDecision {
    const t = this.now();
    const from = t - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.delete(key); // re-insert: Map order = least recently used first
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.evict(from);
    return { ok: true, retryAfterSec: 0 };
  }

  private evict(from: number): void {
    for (const [k, v] of this.hits) {
      if (v.every((x) => x <= from)) this.hits.delete(k);
    }
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }

  /** For tests and diagnostics. */
  get size(): number { return this.hits.size; }
}
