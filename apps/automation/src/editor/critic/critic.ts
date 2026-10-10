import { z } from 'zod';
import { isSlopWarning } from '../post/slop-lint';

/**
 * Spec 034 FR-004: the pre-publish critic's verdict.
 *
 * The critic model scores a post 1–5 on six axes and proposes a verdict; code
 * turns the scores into the final verdict (`decideVerdict`), so a lenient model
 * can never pass a post its own scores fail:
 *
 *   1. any score ≤ CRITIC_REJECT_AT (2)                         → reject
 *   2. the model's own verdict is `reject`                      → reject
 *   3. any score ≤ CRITIC_REVISE_AT (3)                         → revise
 *   4. ≥ CRITIC_SLOP_REVISE (2) slop warnings from the lint     → revise
 *   5. a humour / slang marker on a resource where it is off    → revise
 *   6. the model's own verdict is `revise`                      → revise
 *   7. otherwise                                                → pass
 *
 * The model can make the verdict stricter, never more lenient.
 */

/** Score axes (1–5, 5 = best). `ai_likeness` 5 = reads as written by a person, 1 = obvious AI text. */
export const CRITIC_SCORE_KEYS = ['ai_likeness', 'sense', 'voice', 'grounding', 'audience_asks', 'format_fit'] as const;
export type CriticScoreKey = typeof CRITIC_SCORE_KEYS[number];
export type CriticScores = Record<CriticScoreKey, number>;
export type CriticVerdictKind = 'pass' | 'revise' | 'reject';

export const CRITIC_REJECT_AT = 2;
export const CRITIC_REVISE_AT = 3;
export const CRITIC_SLOP_REVISE = 2;
/** Lint warnings that mean humour / slang on a resource where the owner did not allow them (spec 034 FR-002). */
export const VOICE_OFF_WARNINGS = ['slop_humor_off', 'slop_slang_off'] as const;

const score = z.number().int().min(1).max(5);

/** The critic's tool input (the model's answer). */
export const CritiqueInput = z.object({
  scores: z.object({
    ai_likeness:   score.describe('5 — текст звучить як написаний людиною; 1 — очевидний AI-текст зі штампами'),
    sense:         score.describe('5 — звʼязно, по суті, відповідає темі й джерелу; 1 — нісенітниця або не про те'),
    voice:         score.describe('5 — тон ресурсу, без заборонених жартів і сленгу; 1 — чужий тон, жарти чи сленг там, де вони вимкнені'),
    grounding:     score.describe('5 — кожен факт є в джерелі; 1 — вигадані цифри, імена, цитати'),
    audience_asks: score.describe('5 — питань до читачів немає або одне доречне; 1 — нав’язливі питання, опитування без причини'),
    format_fit:    score.describe('5 — формат і довжина пасують змісту й платформі; 1 — формат не підходить'),
  }),
  verdict: z.enum(['pass', 'revise', 'reject']),
  notes:   z.string().min(3).max(800).describe('Коротко українською: що саме виправити (цитуй проблемні місця). Для pass — одне речення.'),
});
export type Critique = z.infer<typeof CritiqueInput>;

export interface VerdictDecision {
  verdict: CriticVerdictKind;
  /** Which rule decided it (for the trace and the stats). */
  reason:  string;
}

/** The lint warnings the critic reads (slop counters only; spec 034 T1). */
export function slopCodes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((w) => w.code).filter(isSlopWarning);
}

/** Deterministic final verdict from the scores, the model's own verdict and the slop warnings. */
export function decideVerdict(c: Pick<Critique, 'scores' | 'verdict'>, slopWarningCodes: readonly string[] = []): VerdictDecision {
  const low = (max: number) => CRITIC_SCORE_KEYS.filter((k) => c.scores[k] <= max);
  const rejectAxes = low(CRITIC_REJECT_AT);
  if (rejectAxes.length) return { verdict: 'reject', reason: `score_le_${CRITIC_REJECT_AT}: ${rejectAxes.join(', ')}` };
  if (c.verdict === 'reject') return { verdict: 'reject', reason: 'model_reject' };
  const reviseAxes = low(CRITIC_REVISE_AT);
  if (reviseAxes.length) return { verdict: 'revise', reason: `score_le_${CRITIC_REVISE_AT}: ${reviseAxes.join(', ')}` };
  if (slopWarningCodes.length >= CRITIC_SLOP_REVISE) return { verdict: 'revise', reason: `slop_warnings: ${slopWarningCodes.length}` };
  const off = slopWarningCodes.filter((w) => (VOICE_OFF_WARNINGS as readonly string[]).includes(w));
  if (off.length) return { verdict: 'revise', reason: `voice_off: ${off.join(', ')}` };
  if (c.verdict === 'revise') return { verdict: 'revise', reason: 'model_revise' };
  return { verdict: 'pass', reason: 'scores_ok' };
}

/**
 * What is stored on the slot (`editor_slots.critic`) and on a chat draft
 * (`editor_drafts.critic`), shown on the approval card, the draft card and the
 * run trace. `verdict: 'error'` = the critic did not answer (fail-safe path).
 */
export interface StoredCritic {
  verdict:        CriticVerdictKind | 'error';
  scores:         CriticScores | null;
  notes:          string;
  /** The model's own verdict before the thresholds. */
  model_verdict?: CriticVerdictKind | null;
  /** The rule that decided the verdict (see `decideVerdict`), or the error. */
  reason:         string;
  /** 1 = the first critic pass, 2 = after the one rewrite. */
  pass:           number;
  /** Slop warning codes of the lint the critic read. */
  slop_warnings:  string[];
  model:          string | null;
  run_id:         string | null;
  cost_usd:       number;
  at:             string;
  /** Approval mode: a second `revise` goes to the owner with these notes (not a reject). */
  final?:         boolean;
  /** Earlier passes of the same slot (pass 1 when this is pass 2). */
  history?:       Array<Pick<StoredCritic, 'verdict' | 'scores' | 'notes' | 'reason' | 'pass' | 'at'>>;
}

/** A short line for traces, Inbox items and slot errors: «revise (ai_likeness 3, voice 2): notes». */
export function criticLine(c: Pick<StoredCritic, 'verdict' | 'scores' | 'notes'>, max = 300): string {
  const weak = c.scores ? CRITIC_SCORE_KEYS.filter((k) => c.scores![k] <= CRITIC_REVISE_AT).map((k) => `${k} ${c.scores![k]}`) : [];
  return `${c.verdict}${weak.length ? ` (${weak.join(', ')})` : ''}: ${c.notes}`.replace(/\s+/g, ' ').slice(0, max);
}

/**
 * A waiting post the critic did not pass (approval mode: a second `revise`, or the critic was unavailable) is
 * never approved in bulk or by the autonomy switch — the owner decides it one by one, like a post with lint warnings.
 */
export function heldByCritic(c: Pick<StoredCritic, 'verdict'> | null | undefined): boolean {
  return !!c && c.verdict !== 'pass';
}
