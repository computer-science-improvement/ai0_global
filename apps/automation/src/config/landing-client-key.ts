// apps/automation/src/config/landing-client-key.ts
// Spec 026 FR-009/FR-011: the landing never stores a visitor's IP. Rate limits and
// lead dedup use `ip_hash = sha256(salt + ip)`, with the salt derived from the same
// secret spec 022 uses for its join/click hashes (PROMO_HASH_SALT, else
// TOKEN_ENCRYPTION_KEY). Without either, a per-process random salt is used: hashes
// then only match within one run (dedup and limits still work until a restart).
import { createHash, randomBytes } from 'crypto';
import { SlidingWindowLimiter, type RateLimitDecision } from '../common/rate-limit/sliding-window-limiter';

/** Public write limits: the CTA beacon (FR-009) and lead intake (FR-011), per client. */
export const CTA_LIMIT = { max: 60, windowMs: 60_000 } as const;
export const LEAD_LIMIT = { max: 5, windowMs: 3_600_000 } as const;

/** The salted client key plus the per-client limiters of the public landing writes. */
export class LandingClientGate {
  private readonly cta: SlidingWindowLimiter;
  private readonly leads: SlidingWindowLimiter;

  constructor(readonly salt: string, now: () => number = Date.now) {
    this.cta = new SlidingWindowLimiter(CTA_LIMIT.max, CTA_LIMIT.windowMs, now);
    this.leads = new SlidingWindowLimiter(LEAD_LIMIT.max, LEAD_LIMIT.windowMs, now);
  }

  key(ip: string | null | undefined): string { return hashClientIp(ip, this.salt); }
  ctaHit(ip: string | null | undefined): RateLimitDecision { return this.cta.hit(this.key(ip)); }
  leadHit(ip: string | null | undefined): RateLimitDecision { return this.leads.hit(this.key(ip)); }
}

export function resolveLandingSalt(env: (key: string) => string | undefined): { salt: string; persistent: boolean } {
  const secret = env('PROMO_HASH_SALT') || env('TOKEN_ENCRYPTION_KEY');
  if (secret) return { salt: createHash('sha256').update(`ai0-landing:${secret}`).digest('hex'), persistent: true };
  return { salt: randomBytes(32).toString('hex'), persistent: false };
}

/** sha256(salt + ip) as hex; a missing IP hashes to one shared "unknown" bucket. */
export function hashClientIp(ip: string | null | undefined, salt: string): string {
  return createHash('sha256').update(`${salt}${ip ?? 'unknown'}`).digest('hex');
}
