import { Injectable, Logger } from '@nestjs/common';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that a model response is an actual post,
 * not a billing error, refusal, API fault, or gibberish.
 */
@Injectable()
export class PostValidator {
  private readonly logger = new Logger(PostValidator.name);

  private readonly BLACKLIST: Array<{ pattern: string; reason: string }> = [
    // ── Billing / quota ──────────────────────────────────────────────────
    { pattern: 'insufficient_quota',    reason: 'billing: quota exceeded' },
    { pattern: 'insufficient credits',  reason: 'billing: insufficient credits' },
    { pattern: 'you have run out',      reason: 'billing: out of credits' },
    { pattern: 'payment required',      reason: 'billing: payment required' },
    { pattern: 'exceeded your',         reason: 'billing: limit exceeded' },
    { pattern: 'billing',               reason: 'billing: billing message' },
    { pattern: 'subscribe to',          reason: 'billing: subscription prompt' },
    { pattern: 'upgrade your plan',     reason: 'billing: upgrade prompt' },

    // ── Rate limits / service errors ─────────────────────────────────────
    { pattern: 'rate limit',            reason: 'api: rate limit' },
    { pattern: 'too many requests',     reason: 'api: too many requests' },
    { pattern: 'overloaded',            reason: 'api: service overloaded' },
    { pattern: 'service unavailable',   reason: 'api: service unavailable' },
    { pattern: '"error":',              reason: 'api: raw error json' },

    // ── Model refusals ───────────────────────────────────────────────────
    { pattern: 'i cannot',              reason: 'refusal: i cannot' },
    { pattern: "i'm unable",            reason: 'refusal: unable' },
    { pattern: 'i am unable',           reason: 'refusal: unable' },
    { pattern: 'i apologize',           reason: 'refusal: apologize' },
    { pattern: 'as an ai',              reason: 'refusal: ai identity' },
    { pattern: 'as a language model',   reason: 'refusal: language model' },
    { pattern: 'i am an ai',            reason: 'refusal: ai identity' },
    { pattern: 'i cannot assist',       reason: 'refusal: cannot assist' },
    { pattern: 'i cannot provide',      reason: 'refusal: cannot provide' },
    { pattern: "i don't have access",   reason: 'refusal: no access' },

    // ── Meta-commentary (model explaining itself) ────────────────────────
    { pattern: 'here is the post',      reason: 'meta: model explaining output' },
    { pattern: 'here is a',             reason: 'meta: model explaining output' },
    { pattern: 'here\'s the',           reason: 'meta: model explaining output' },
    { pattern: 'telegram post:',        reason: 'meta: labeled output' },
    { pattern: 'formatted post:',       reason: 'meta: labeled output' },
    { pattern: 'the post:',             reason: 'meta: labeled output' },
  ];

  validate(text: string | null | undefined): ValidationResult {
    if (!text || text.trim().length === 0) {
      return { valid: false, reason: 'empty response' };
    }

    const trimmed = text.trim();

    if (trimmed === 'SKIP_POST') {
      return { valid: false, reason: 'model signalled SKIP_POST — content not formattable' };
    }

    if (trimmed.length < 40) {
      return { valid: false, reason: `too short (${trimmed.length} chars)` };
    }

    if (trimmed.length > 4096) {
      return { valid: false, reason: `too long (${trimmed.length} chars)` };
    }

    const lower = trimmed.toLowerCase();
    for (const { pattern, reason } of this.BLACKLIST) {
      if (lower.includes(pattern)) {
        return { valid: false, reason };
      }
    }

    return { valid: true };
  }

  /** Validate and log the reason if invalid */
  check(text: string | null | undefined, context: string): boolean {
    const result = this.validate(text);
    if (!result.valid) {
      this.logger.warn(`Rejected model response [${context}]: ${result.reason}`);
    }
    return result.valid;
  }
}
