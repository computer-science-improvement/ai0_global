import { z } from 'zod';
import { isSlopWarning } from '../post/slop-lint';
import type { StoredSource } from './stored-sources';
import type { FailedEdit, TextEdit } from './spec-edits';

/**
 * Spec 034 FR-004: the pre-publish critic's verdict.
 *
 * The critic model scores a post 1–5 on seven axes (spec 041 FR-001 added `language`) and proposes a verdict; code
 * turns the scores into the final verdict (`decideVerdict`), so a lenient model
 * can never pass a post its own scores fail:
 *
 *   1. any score ≤ CRITIC_REJECT_AT (2)                         → reject
 *      (`owner_rules` ≤ 2 names the broken owner rules: «owner_rules: #12, #15»)
 *   2. the model's own verdict is `reject`                      → reject
 *   2a. spec 041: owner rules in the prompt without a score or a per-rule verdict → revise (`owner_rules_missing`)
 *   3. any score ≤ CRITIC_REVISE_AT (3)                         → revise
 *   4. ≥ CRITIC_SLOP_REVISE (2) slop warnings from the lint     → revise
 *   5. a humour / slang marker on a resource where it is off    → revise
 *   6. the model's own verdict is `revise`                      → revise
 *   7. spec 041: a score of 4 with a «quoted» problem in the notes and no edits → revise (`quoted_problem`)
 *   8. otherwise                                                → pass (`pass_with_edits` = a pass whose exact
 *      edits code applies, spec 041 FR-002)
 *
 * The model can make the verdict stricter, never more lenient.
 */

/** Score axes (1–5, 5 = best). `ai_likeness` 5 = reads as written by a person, 1 = obvious AI text. */
export const CRITIC_SCORE_KEYS = ['ai_likeness', 'sense', 'voice', 'grounding', 'audience_asks', 'format_fit', 'language'] as const;
export type CriticScoreKey = typeof CRITIC_SCORE_KEYS[number];
/**
 * Spec 040 FR-011: `owner_rules` — does the post keep the channel's owner rules. Scored only when the prompt lists
 * rules, so it is optional (older verdicts and channels without rules have none).
 */
export const CRITIC_OPTIONAL_SCORE_KEYS = ['owner_rules'] as const;
export type CriticOptionalScoreKey = typeof CRITIC_OPTIONAL_SCORE_KEYS[number];
export type CriticScores = Record<CriticScoreKey, number> & Partial<Record<CriticOptionalScoreKey, number>>;
/** Every axis a verdict may carry, in display order. */
export const CRITIC_ALL_SCORE_KEYS = [...CRITIC_SCORE_KEYS, ...CRITIC_OPTIONAL_SCORE_KEYS] as const;
export type CriticVerdictKind = 'pass' | 'revise' | 'reject';

export const CRITIC_REJECT_AT = 2;
export const CRITIC_REVISE_AT = 3;
export const CRITIC_SLOP_REVISE = 2;
/** Lint warnings that mean humour / slang on a resource where the owner did not allow them (spec 034 FR-002). */
export const VOICE_OFF_WARNINGS = ['slop_humor_off', 'slop_slang_off'] as const;

const score = z.number().int().min(1).max(5);
/** Spec 041 FR-002: at most this many exact edits in one `pass_with_edits`. */
export const MAX_CRITIC_EDITS = 8;

/** The critic's tool input (the model's answer). */
export const CritiqueInput = z.object({
  scores: z.object({
    ai_likeness:   score.describe('5 — текст звучить як написаний людиною; 1 — очевидний AI-текст зі штампами'),
    sense:         score.describe('5 — звʼязно, по суті, відповідає темі й джерелу; 1 — нісенітниця або не про те'),
    voice:         score.describe('5 — тон ресурсу, без заборонених жартів і сленгу; 1 — чужий тон, жарти чи сленг там, де вони вимкнені'),
    grounding:     score.describe('5 — кожен факт є в джерелі; 1 — вигадані цифри, імена, цитати'),
    audience_asks: score.describe('5 — питань до читачів немає або одне доречне; 1 — нав’язливі питання, опитування без причини'),
    format_fit:    score.describe('5 — формат і довжина пасують змісту й платформі; 1 — формат не підходить'),
    language:      score.describe('5 — грамотна українська; ≤ 3 — русизм, калька, помилка відмінка, займенник не до того слова, у/в чи і/й не за правилом (процитуй у notes)'),
    owner_rules:   score.optional().describe('Лише коли в промпті є правила власника: 5 — жодне не порушено; ≤ 2 — пост порушує правило (його id — у broken_rules)'),
  }),
  broken_rules: z.array(z.number().int().positive()).max(10).optional()
    .describe('id правил власника (#N з блоку правил), які пост порушує; порожньо, якщо порушень немає'),
  rule_checks: z.array(z.object({
    id:    z.number().int().positive().describe('id правила (#N з блоку правил)'),
    kept:  z.boolean().describe('true — пост правило дотримує (або правило не про цей пост)'),
    quote: z.string().max(200).optional().describe('Для порушеного правила — дослівна цитата з поста, що його порушує'),
  })).max(30).optional()
    .describe('Обовʼязково, коли в промпті є правила власника: вердикт по КОЖНОМУ правилу з блоку'),
  verdict: z.enum(['pass', 'pass_with_edits', 'revise', 'reject']),
  edits:   z.array(z.object({
    from: z.string().min(2).max(300).describe('Точний фрагмент тексту поста, як він написаний (має зустрічатися в пості один раз)'),
    to:   z.string().max(300).describe('Чим замінити'),
  })).max(MAX_CRITIC_EDITS).optional()
    .describe('Лише для pass_with_edits: дрібні точкові правки (слово, відмінок, займенник, у/в), які код застосує сам без переписування'),
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

/** A «quoted» fragment of at least two letters in the notes: the critic named a concrete problem. */
const QUOTED = /«[^»]*\p{L}[^»]*\p{L}[^»]*»|"[^"]*\p{L}[^"]*\p{L}[^"]*"/u;

/** Deterministic final verdict from the scores, the model's own verdict and the slop warnings. */
export function decideVerdict(
  c: Pick<Critique, 'scores' | 'verdict' | 'broken_rules'> & Partial<Pick<Critique, 'notes' | 'edits'>> & { missing_rules?: number[] },
  slopWarningCodes: readonly string[] = [],
): VerdictDecision {
  const scores = c.scores as Partial<Record<string, number>>;
  const low = (max: number) => CRITIC_ALL_SCORE_KEYS.filter((k) => typeof scores[k] === 'number' && scores[k]! <= max);
  // Spec 040 FR-011: a low owner_rules axis names the rules the post broke.
  const named = (axes: readonly string[]) => axes.map((k) => (k === 'owner_rules' && c.broken_rules?.length
    ? `owner_rules (${c.broken_rules.map((id) => `#${id}`).join(', ')})` : k)).join(', ');
  const rejectAxes = low(CRITIC_REJECT_AT);
  if (rejectAxes.length) return { verdict: 'reject', reason: `score_le_${CRITIC_REJECT_AT}: ${named(rejectAxes)}` };
  if (c.verdict === 'reject') return { verdict: 'reject', reason: 'model_reject' };
  // Spec 041 FR-005: with owner rules in the prompt, every rule gets a verdict (and the axis a score).
  if (c.missing_rules?.length) return { verdict: 'revise', reason: `owner_rules_missing: ${c.missing_rules.map((id) => `#${id}`).join(', ')}` };
  const reviseAxes = low(CRITIC_REVISE_AT);
  if (reviseAxes.length) return { verdict: 'revise', reason: `score_le_${CRITIC_REVISE_AT}: ${named(reviseAxes)}` };
  if (slopWarningCodes.length >= CRITIC_SLOP_REVISE) return { verdict: 'revise', reason: `slop_warnings: ${slopWarningCodes.length}` };
  const off = slopWarningCodes.filter((w) => (VOICE_OFF_WARNINGS as readonly string[]).includes(w));
  if (off.length) return { verdict: 'revise', reason: `voice_off: ${off.join(', ')}` };
  if (c.verdict === 'revise') return { verdict: 'revise', reason: 'model_revise' };
  const edits = c.verdict === 'pass_with_edits' ? c.edits ?? [] : [];
  // Spec 041 FR-002: 7 of 15 passes of review 2 carried a fix the post never got. A 4 that quotes a problem
  // is fixed, either by the critic's own exact edits or by a rewrite.
  const fours = low(4);
  if (fours.length && !edits.length && c.notes && QUOTED.test(c.notes)) return { verdict: 'revise', reason: `quoted_problem: ${named(fours)}` };
  return { verdict: 'pass', reason: edits.length ? 'scores_ok_with_edits' : 'scores_ok' };
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
  model_verdict?: CriticVerdictKind | 'pass_with_edits' | null;
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
  history?:       Array<Pick<StoredCritic, 'verdict' | 'scores' | 'notes' | 'reason' | 'pass' | 'at'> & Partial<Pick<StoredCritic, 'cost_usd' | 'route'>>>;
  /** Spec 037 T17: the pages the run read (url, date, tier, images), for the post audit and the approval card. */
  sources?:       StoredSource[];
  /** Spec 040 FR-011: ids of the owner rules the post broke (only ids that were in the prompt). */
  broken_rules?:  number[];
  /** Spec 041 FR-006: every lint warning code the critic read (a pass with codes = overruled warnings). */
  lint_warnings?: string[];
  /** Spec 041 FR-007: the draft's risk and the model it was routed to. */
  route?:         { risk: number; level: 'high' | 'low'; factors: string[]; model: string };
  /** Spec 041 FR-007: the critic's spend on this post across its passes (`cost_usd` is this pass only). */
  cost_total_usd?: number;
  /** Spec 041 FR-005: the critic's verdict on each owner rule in its prompt. */
  rule_checks?:   Array<{ id: number; kept: boolean; quote?: string }>;
  /** Spec 041 FR-002: the exact edits the critic proposed (`pass_with_edits`). */
  edits?:         TextEdit[];
  /** Spec 041 FR-002: what code applied to the spec before publishing (critic edits and lint euphony fixes). */
  edits_applied?: TextEdit[];
  /** Spec 041 FR-002: edits that did not match exactly once (dropped on the last pass, a revise before it). */
  edits_failed?:  FailedEdit[];
}

/** A short line for traces, Inbox items and slot errors: «revise (ai_likeness 3, voice 2): notes». */
export function criticLine(c: Pick<StoredCritic, 'verdict' | 'scores' | 'notes'>, max = 300): string {
  const sc = c.scores as Partial<Record<string, number>> | null;
  const weak = sc ? CRITIC_ALL_SCORE_KEYS.filter((k) => typeof sc[k] === 'number' && sc[k]! <= CRITIC_REVISE_AT).map((k) => `${k} ${sc[k]}`) : [];
  return `${c.verdict}${weak.length ? ` (${weak.join(', ')})` : ''}: ${c.notes}`.replace(/\s+/g, ' ').slice(0, max);
}

/**
 * A waiting post the critic did not pass (approval mode: a second `revise`, or the critic was unavailable) is
 * never approved in bulk or by the autonomy switch — the owner decides it one by one, like a post with lint warnings.
 */
export function heldByCritic(c: Pick<StoredCritic, 'verdict'> | null | undefined): boolean {
  return !!c && c.verdict !== 'pass';
}
