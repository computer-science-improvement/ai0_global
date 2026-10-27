import { z } from 'zod';
import { isSlopWarning } from '../post/slop-lint';
import type { StoredSource } from './stored-sources';
import type { FailedEdit, TextEdit } from './spec-edits';
import { CLIP_MARK, longText, longTextNote } from '../harness/clip-text';
import type { RejectedEdit } from './safe-edits';
import type { SourceCoverage } from './read-capture';

/**
 * Spec 034 FR-004: the pre-publish critic's verdict.
 *
 * The critic model scores a post 1–5 on seven axes (spec 041 FR-001 added `language`) and proposes a verdict; code
 * turns the scores into the final verdict (`decideVerdict`), so a lenient model can never pass a post its own scores
 * fail. Spec 067 FR-002 split the contract by pass: a low score no longer kills a post one rewrite can fix, and the
 * second pass checks the fixes instead of starting again.
 *
 * Pass 1:
 *   1. the model's verdict is `reject`, or `sense` ≤ 2          → reject (the post is not about anything)
 *   2. any other score ≤ CRITIC_REJECT_AT (2)                   → revise (`score_le_2_fixable`)
 *      (`owner_rules` ≤ 2 names the broken owner rules: «owner_rules: #12, #15»)
 *   3. any score ≤ CRITIC_REVISE_AT (3)                         → revise
 *   4. a blocking issue with a quote found in the post, not fixed by an edit → revise
 *   5. spec 041: owner rules in the prompt without a score or a per-rule verdict → revise (`owner_rules_missing`);
 *      ≥ CRITIC_SLOP_REVISE (2) slop warnings; a humour / slang marker on a resource where it is off → revise
 *   6. the model's own verdict is `revise`                      → revise
 *   7. otherwise                                                → pass (`pass_with_edits` = a pass whose exact
 *      edits code applies, spec 041 FR-002); remarks that are not blocking issues stay advice in the notes
 *
 * Pass 2 (after the one rewrite):
 *   1. the model's verdict is `reject`; any score ≤ 2           → reject (grounding ≤ 2 is a revise when the source was
 *      not read whole and the code found no number missing)
 *   2. a blocking item of pass 1 not fixed (`previous_checks`; a missing or partial answer counts as unfixed), a new
 *      blocking issue, a hard lint warning still there, owner rules without a verdict, slop, humour off → revise
 *   3. otherwise                                                → pass (`pass2_advice`: a new 3 and the model's own
 *      `revise` without such an item are advice, kept in the notes)
 *
 * On pass 1 the model can make the verdict stricter, never more lenient than its scores. On pass 2 only the items
 * above can: a `revise` of the model with no unfixed item and no new blocking issue ends as a pass.
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
/** Spec 067 FR-002: at most this many issues are kept from one verdict (more are cut, not refused). */
export const MAX_CRITIC_ISSUES = 8;

/**
 * Spec 067 FR-002: one concrete remark. A `blocking` one with a quote found in the post sends the post back for a
 * rewrite; the rest is advice. Over-long fields are cut, not refused: a refused verdict costs a critic turn.
 */
export const CriticIssueInput = z.object({
  quote:    longText(0, 200).optional().describe(`Дослівна цитата проблемного місця з поста (як воно написано в пості). Для blocking — обовʼязкова: без цитати, якої в пості немає, код блокуючим це не вважає; ${longTextNote(200)}`),
  fix:      longText(1, 300).describe(`Що саме виправити, одним реченням; ${longTextNote(300)}`),
  axis:     z.enum(CRITIC_ALL_SCORE_KEYS).describe('До якої осі оцінок це належить'),
  blocking: z.boolean().describe('true — без виправлення пост не можна публікувати: фактична помилка (число, імʼя, цитата, якої немає в джерелі), мовна помилка з цитатою, порушене правило власника. false — порада'),
});
export type CriticIssue = z.infer<typeof CriticIssueInput>;

/** The critic's tool input (the model's answer). */
export const CritiqueInput = z.object({
  scores: z.object({
    ai_likeness:   score.describe('5 — текст звучить як написаний людиною; 1 — очевидний AI-текст зі штампами'),
    sense:         score.describe('5 — звʼязно, по суті, відповідає темі й джерелу; 1 — нісенітниця або не про те'),
    voice:         score.describe('5 — тон ресурсу, без заборонених жартів і сленгу; 1 — чужий тон, жарти чи сленг там, де вони вимкнені'),
    grounding:     score.describe('5 — кожен факт є в джерелі; 1 — вигадані цифри, імена, цитати'),
    audience_asks: score.describe('5 — питань до читачів немає або одне доречне; 1 — нав’язливі питання, опитування без причини'),
    format_fit:    score.describe('5 — формат і довжина пасують змісту й платформі; 1 — формат не підходить'),
    language:      score.describe('5 — грамотна мова поста (типово українська; інша — з рядка «Мова поста»); ≤ 3 — для української: русизм, калька, помилка відмінка, займенник не до того слова, у/в чи і/й не за правилом (процитуй у notes)'),
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
  issues: z.array(CriticIssueInput).optional()
    .describe(`Конкретні зауваження до поста, до ${MAX_CRITIC_ISSUES}. Блокуючі (blocking: true) повертають пост на переписування; решта — поради. Без issues пост із четвірками проходить`),
  previous_checks: z.array(z.object({
    n:     z.number().int().min(1).describe('номер пункту з блоку «Що треба було виправити»'),
    fixed: z.boolean().describe('true — у новому тексті цього більше немає'),
  })).optional()
    .describe('Лише для другого проходу: по КОЖНОМУ пункту з блоку «Що треба було виправити» — виправлено чи ні. Пропущений пункт код вважає невиправленим'),
  verdict: z.enum(['pass', 'pass_with_edits', 'revise', 'reject']),
  edits:   z.array(z.object({
    from: z.string().min(2).max(300).describe('Точний фрагмент тексту поста, як він написаний (має зустрічатися в пості один раз)'),
    to:   z.string().max(300).describe('Чим замінити'),
  })).max(MAX_CRITIC_EDITS).optional()
    .describe('Лише для pass_with_edits: дрібні точкові правки (слово, відмінок, займенник, у/в), які код застосує сам без переписування'),
  notes:   longText(3, 800).describe(`Коротко українською: що саме виправити (цитуй проблемні місця). Для pass — одне речення; ${longTextNote(800)}`),
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

/**
 * Spec 067 FR-002 (A1): what pass 1 asked to fix, numbered [1..n] for pass 2 (the prompt asks `previous_checks` per
 * number, `decideVerdict` reads the answer). Pass 1's blocking issues; with none (an old-style verdict), one item per
 * score ≤ 3 and one per edit that did not apply. Empty when pass 1 asked for nothing in particular (a lint-only revise).
 */
export interface PreviousItem { n: number; fix: string; quote?: string; axis?: string }

export function previousItemsOf(
  prev: (Pick<StoredCritic, 'scores'> & Partial<Pick<StoredCritic, 'issues' | 'edits_failed'>>) | null | undefined,
): PreviousItem[] {
  if (!prev) return [];
  const blocking = (prev.issues ?? []).filter((i) => i.blocking);
  let items: Array<Omit<PreviousItem, 'n'>>;
  if (blocking.length) {
    items = blocking.map((i) => ({ fix: i.fix, ...(i.quote ? { quote: i.quote } : {}), axis: i.axis }));
  } else {
    const sc = (prev.scores ?? {}) as Partial<Record<string, number>>;
    items = [
      ...CRITIC_ALL_SCORE_KEYS.filter((k) => typeof sc[k] === 'number' && sc[k]! <= CRITIC_REVISE_AT)
        .map((k) => ({ fix: `оцінка ${k} ${sc[k]} — виправ те, що названо в зауваженнях`, axis: k })),
      ...(prev.edits_failed ?? []).map((e) => ({ fix: `правка не застосувалась: «${e.from}» → «${e.to}»`, quote: e.from })),
    ];
  }
  return items.map((x, i) => ({ n: i + 1, ...x }));
}

/** What `decideVerdict` needs beyond the model's answer (spec 067 A2); without it: pass 1, nothing read, nothing to compare. */
export interface VerdictContext {
  /** 2 after the one in-run rewrite. */
  pass:             1 | 2;
  /** How much of the cited source the critic was shown (the lowest among the cited sources). */
  coverage:         SourceCoverage;
  /** Numbers the code found in no text the author read. */
  codeMissing:      readonly string[];
  /** Pass 2: the items pass 1 asked to fix. */
  previousBlocking: readonly PreviousItem[];
  /** Lint codes that still stand and are never advice: `poster_mismatch`, `number_not_in_sources`. */
  hardLint:         readonly string[];
  /** The post text: a blocking issue counts only with a quote that is in it. Absent = the quotes are not checked. */
  postText?:        string;
}

/** The lint warnings a second pass may not carry (spec 067 FR-002); `number_not_in_sources` comes from the code check of the numbers. */
export const HARD_LINT_CODES = ['poster_mismatch', 'number_not_in_sources'] as const;

/** A text for comparing a quote with the post: one kind of quote and apostrophe, one space, no case, no cut marks. */
const quoteKey = (s: string): string => s.replace(CLIP_MARK, '').replace(/[«»“”„"]/g, '"').replace(/[‘’ʼ`]/g, "'")
  .replace(/(?:…|\.{3})\s*$/u, '').replace(/^\s*(?:…|\.{3})/u, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The blocking issues that send a post back: each has a quote found in the post (so praise in quotes and a vague
 * remark do not count) and no applied edit of the model removes it (`pass_with_edits`: the quote lies inside an edit's `from`).
 */
export function countedIssues(
  c: Pick<Critique, 'verdict'> & Partial<Pick<Critique, 'issues' | 'edits'>>, postText?: string,
): CriticIssue[] {
  const post = postText == null ? null : quoteKey(postText);
  const fixedBy = c.verdict === 'pass_with_edits' ? (c.edits ?? []).map((e) => quoteKey(e.from)) : [];
  return (c.issues ?? []).slice(0, MAX_CRITIC_ISSUES).filter((i) => {
    if (!i.blocking) return false;
    const q = i.quote ? quoteKey(i.quote) : '';
    if (!q) return false;
    if (post != null && !post.includes(q)) return false;
    return !fixedBy.some((from) => from.includes(q));
  });
}

type VerdictInput = Pick<Critique, 'scores' | 'verdict' | 'broken_rules'>
  & Partial<Pick<Critique, 'notes' | 'edits' | 'issues' | 'previous_checks'>> & { missing_rules?: number[] };

/** Deterministic final verdict from the scores, the model's own verdict, its issues and the slop warnings (see the header). */
export function decideVerdict(c: VerdictInput, slopWarningCodes: readonly string[] = [], o: Partial<VerdictContext> = {}): VerdictDecision {
  const scores = c.scores as Partial<Record<string, number>>;
  const low = (max: number) => CRITIC_ALL_SCORE_KEYS.filter((k) => typeof scores[k] === 'number' && scores[k]! <= max);
  // Spec 040 FR-011: a low owner_rules axis names the rules the post broke.
  const named = (axes: readonly string[]) => axes.map((k) => (k === 'owner_rules' && c.broken_rules?.length
    ? `owner_rules (${c.broken_rules.map((id) => `#${id}`).join(', ')})` : k)).join(', ');
  const pass = o.pass ?? 1;
  const counted = countedIssues(c, o.postText);
  const countedLine = () => `blocking_issue: ${[...new Set(counted.map((i) => i.axis))].join(', ')}`;
  // Spec 041 FR-005: with owner rules in the prompt, every rule gets a verdict (and the axis a score).
  const missingRules = c.missing_rules?.length ? { verdict: 'revise' as const, reason: `owner_rules_missing: ${c.missing_rules.map((id) => `#${id}`).join(', ')}` } : null;
  const slop = slopWarningCodes.length >= CRITIC_SLOP_REVISE ? { verdict: 'revise' as const, reason: `slop_warnings: ${slopWarningCodes.length}` } : null;
  const off = slopWarningCodes.filter((w) => (VOICE_OFF_WARNINGS as readonly string[]).includes(w));
  const voiceOff = off.length ? { verdict: 'revise' as const, reason: `voice_off: ${off.join(', ')}` } : null;
  const edits = c.verdict === 'pass_with_edits' ? c.edits ?? [] : [];
  const scoresOk = { verdict: 'pass' as const, reason: edits.length ? 'scores_ok_with_edits' : 'scores_ok' };

  if (pass === 2) {
    if (c.verdict === 'reject') return { verdict: 'reject', reason: 'model_reject' };
    // A second look at a rewrite: a score of 2 or less is a reject, except grounding when the critic did not see the whole source and the code found no number missing (the fact may be elsewhere in it).
    const lowAxes = low(CRITIC_REJECT_AT);
    const unconfirmed = (o.coverage ?? 'none') !== 'full' && !(o.codeMissing ?? []).length;
    const hard = lowAxes.filter((k) => !(k === 'grounding' && unconfirmed));
    if (hard.length) return { verdict: 'reject', reason: `score_le_${CRITIC_REJECT_AT}: ${named(hard)}` };
    if (lowAxes.length) return { verdict: 'revise', reason: `score_le_${CRITIC_REJECT_AT}_fixable: ${named(lowAxes)}` };
    const items = o.previousBlocking ?? [];
    if (items.length) {
      const answered = new Map<number, boolean>();
      for (const k of c.previous_checks ?? []) answered.set(k.n, (answered.get(k.n) ?? true) && k.fixed);
      const unfixed = items.filter((it) => answered.get(it.n) !== true);
      if (unfixed.length) return { verdict: 'revise', reason: `${c.previous_checks?.length ? 'previous_unfixed' : 'previous_checks_missing'}: ${unfixed.map((it) => `#${it.n}`).join(', ')}` };
    }
    if (counted.length) return { verdict: 'revise', reason: countedLine() };
    if (o.hardLint?.length) return { verdict: 'revise', reason: `hard_lint: ${o.hardLint.join(', ')}` };
    if (missingRules) return missingRules;
    if (slop) return slop;
    if (voiceOff) return voiceOff;
    // Everything else is advice: a new 3, the model's own `revise` with nothing blocking behind it.
    const advice = [...low(CRITIC_REVISE_AT).map((k) => `${k} ${scores[k]}`), ...(c.verdict === 'revise' ? ['model_revise'] : [])];
    return advice.length ? { verdict: 'pass', reason: `pass2_advice: ${advice.join(', ')}` } : scoresOk;
  }

  // Pass 1: only a post that is about nothing, or the model's own reject, is lost; the rest can be fixed once.
  if ((scores.sense ?? 5) <= CRITIC_REJECT_AT) return { verdict: 'reject', reason: `score_le_${CRITIC_REJECT_AT}: sense` };
  if (c.verdict === 'reject') return { verdict: 'reject', reason: 'model_reject' };
  const fixable = low(CRITIC_REJECT_AT);
  if (fixable.length) return { verdict: 'revise', reason: `score_le_${CRITIC_REJECT_AT}_fixable: ${named(fixable)}` };
  const reviseAxes = low(CRITIC_REVISE_AT);
  if (reviseAxes.length) return { verdict: 'revise', reason: `score_le_${CRITIC_REVISE_AT}: ${named(reviseAxes)}` };
  if (counted.length) return { verdict: 'revise', reason: countedLine() };
  if (missingRules) return missingRules;
  if (slop) return slop;
  if (voiceOff) return voiceOff;
  if (c.verdict === 'revise') return { verdict: 'revise', reason: 'model_revise' };
  return scoresOk;
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
  /** Spec 067 FR-002: the critic's remarks (≤ 8); the blocking ones with a quote found in the post sent it back. */
  issues?:        CriticIssue[];
  /** Spec 067 FR-002: pass 2 — which numbered items of the first pass are fixed now. */
  previous_checks?: Array<{ n: number; fixed: boolean }>;
  /** Spec 067 FR-001: how much of the cited source the critic was shown (the lowest among the cited sources). */
  source_coverage?: SourceCoverage;
  /** Spec 067 A3: the numbers the code check found in no text the author read (≤ 12); with `source_coverage: 'full'` they ban the source. */
  grounding_missing?: string[];
  /** Spec 067 FR-005: ids of the owner rules left out of the critic's prompt (a media rule when the code says no poster applies). */
  rules_skipped?: number[];
  /** Spec 041 FR-002: the exact edits the critic proposed (`pass_with_edits`). */
  edits?:         TextEdit[];
  /** Spec 041 FR-002: what code applied to the spec before publishing (critic edits and lint euphony fixes). */
  edits_applied?: TextEdit[];
  /** Spec 041 FR-002: edits that did not match exactly once (dropped on the last pass, a revise before it). */
  edits_failed?:  FailedEdit[];
  /** Spec 063 FR-004: edits code refused to apply (they drop a word, or the Ukrainian lexicon finds something new in the edited text). */
  edits_rejected?: RejectedEdit[];
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
