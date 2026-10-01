import { Injectable, Logger } from '@nestjs/common';
import type { StrategyRejection } from '../../content-strategy/content-strategy.interface';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  /** Set on invalid results: true = the item itself is unpublishable (mark it
   *  errored), false = the AI call failed (retry later). See validatePost(). */
  permanent?: boolean;
}

const BLACKLIST: Array<{ pattern: string; reason: string }> = [
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


/**
 * Validates that a model response is an actual post,
 * not a billing error, refusal, API fault, or gibberish.
 */
@Injectable()
export class PostValidator {
  private readonly logger = new Logger(PostValidator.name);

  validate(text: string | null | undefined): ValidationResult {
    return validatePost(text);
  }

  /** Validate and log the reason if invalid */
  check(text: string | null | undefined, context: string): boolean {
    const result = this.validate(text);
    if (!result.valid) {
      this.logger.warn(`Rejected model response [${context}]: ${result.reason}`);
    }
    return result.valid;
  }

  /**
   * For a strategy's generate(): log an invalid result and map it to the
   * runner outcome — a StrategyRejection when the failure is permanent (the
   * item gets marked as errored and is never retried), null when it is
   * transient (no response, billing / rate limit / overload → retry later).
   */
  reject(result: ValidationResult, context: string): StrategyRejection | null {
    this.logger.warn(
      `Rejected model response [${context}]: ${result.reason} (${result.permanent ? 'permanent' : 'transient'})`,
    );
    return result.permanent ? { rejected: result.reason ?? 'invalid model response' } : null;
  }
}

/**
 * Pure validation (no logging). Invalid results carry `permanent`:
 *  - false for failures of the AI call rather than of the item — no response
 *    at all (null: API error / agent unavailable), billing, rate limit,
 *    service overload. Retrying the same item later can succeed.
 *  - true for the model's verdict on this item — SKIP_POST, an empty draft,
 *    too short/long, refusals, meta-commentary. Retrying burns tokens forever.
 */
export function validatePost(text: string | null | undefined): ValidationResult {
  if (text === null || text === undefined) {
    return { valid: false, reason: 'no response (AI call failed or agent unavailable)', permanent: false };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'empty response', permanent: true };
  }

  if (trimmed === 'SKIP_POST') {
    return { valid: false, reason: 'model signalled SKIP_POST — content not formattable', permanent: true };
  }

  if (trimmed.length < 40) {
    return { valid: false, reason: `too short (${trimmed.length} chars)`, permanent: true };
  }

  if (trimmed.length > 4096) {
    return { valid: false, reason: `too long (${trimmed.length} chars)`, permanent: true };
  }

  const lower = trimmed.toLowerCase();
  for (const { pattern, reason } of BLACKLIST) {
    if (lower.includes(pattern)) {
      return { valid: false, reason, permanent: !TRANSIENT_REASON.test(reason) };
    }
  }

  return { valid: true };
}

/** Blacklist reasons that describe the AI service, not the item. */
const TRANSIENT_REASON = /^(billing|api):/;
