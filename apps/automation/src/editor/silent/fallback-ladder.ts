import { isToolError, type EditorTool } from '../harness/tool';
import { isContentFailureCode } from './skip-reasons';

/**
 * Spec 037 FR-010 (T10): the fallback ladder of a slot whose post failed.
 *
 *   initial run (the critic's one rewrite on `revise` is inside it, spec 034)
 *     → revise_source   — spec 063 FR-002: a fixable `revise` (the default for revise) re-runs the executor on the SAME
 *                          source with the critic's notes; only a `reject`, a grounding ≤ 2 or a wrong topic bans it;
 *     → next_candidate  — once: a live slot takes the next fresh feed item, a fixed slot re-runs the executor with the
 *                          failure notes and an instruction to pick different material;
 *     → lighter_format  — a lighter format the card / platform allows (longread / carousel → text or photo, …);
 *     → evergreen       — `EditorRunnerDeps.fallbackEvergreen` (silent/evergreen.ts): an evergreen post, ≤ 1 per
 *                          channel per day, all checks + critic; without it this step is not planned;
 *     → skip with the recorded reason.
 *
 * Only content failures climb the ladder: a critic reject (or a second revise, or the executor's skip after a
 * revise) and a lint / guard failure of the publish tool (lint, too similar, too verbatim, source already posted…).
 * A critic outage, a budget block, a cap, quiet hours, "nothing fresh" or the executor's own editorial skip end
 * the slot as before. Every step runs through the AgentLoop, so the executor's and the critic's spend lands in the
 * usage ledger (spec 029) and counts against the channel / agent / global caps; the runner checks the daily budget
 * before each step and stops the ladder when it is hit. Each step and its reason are stored on the slot
 * (`editor_slots.fallback`, migration 076) next to the run id of the step (the run trace).
 */

export type LadderStep = 'initial' | 'revise_source' | 'next_candidate' | 'lighter_format' | 'evergreen';

/** Why the post of an attempt did not pass. */
export interface SlotFailure {
  kind:      'critic_reject' | 'lint' | 'guard';
  /** `critic_rejected`, `lint_failed`, `too_similar`, … */
  code:      string;
  /** The slot error to keep when the ladder ends in a skip (stable prefix: the digest groups by it). */
  reason:    string;
  /** The critic's notes or the lint errors, for the next attempt's prompt. */
  notes:     string | null;
  /** The source the failed post was written from (a live slot takes another item next). */
  sourceUrl: string | null;
  /**
   * Spec 063 FR-002: the critic asked for fixable edits (`revise`, grounding above 2, the right topic): the source is
   * good and the next attempt keeps it. A reject, a low grounding or a wrong topic leave this false.
   */
  fixable?:  boolean;
}

export type StepOutcome =
  | 'published' | 'shadowed' | 'awaiting_approval' | 'approved'      // rescued
  | 'critic_reject' | 'lint' | 'guard'                                // failed again
  | 'no_candidate' | 'unavailable'                                    // the step could not run
  | 'ended';                                                          // a non-content end (skip, outage, budget, …)

export interface FallbackStepRecord {
  step:       LadderStep;
  at:         string;
  format:     string;
  outcome:    StepOutcome;
  reason:     string | null;
  /** The critic's verdict of this attempt (null when the post never reached the critic). */
  verdict:    string | null;
  run_id:     string | null;
  /** The executor run's cost plus the critic's (both already in the usage ledger). */
  cost_usd:   number;
  /** Spec 046 FR-006: critic passes of this attempt (a revise + its rewrite = 2). */
  critic_passes?: number;
  source_url?: string | null;
}

export interface FallbackFinal {
  /** rescued: a later step went out; skipped: every step failed or the ladder stopped; ended: a step ended the slot otherwise. */
  outcome: 'rescued' | 'skipped' | 'ended';
  /** exhausted | budget | too_late (skipped); the slot status (rescued / ended). */
  code:    string;
  step:    LadderStep;
  reason:  string | null;
}

/** editor_slots.fallback (migration 076). */
export interface SlotFallback {
  steps: FallbackStepRecord[];
  final: FallbackFinal | null;
}

/** The ladder does not start a new step this long after the slot's time (stale slots are skipped at 3 h). */
export const LADDER_MAX_LATE_MS = 90 * 60_000;

/**
 * Spec 046 FR-006: no new ladder step once a slot used this many critic passes (review 2: one off-topic slot took
 * 3 executor and 5–6 critic runs; 43% of slot spend bought no post).
 */
export const MAX_CRITIC_PASSES_PER_SLOT = 3;

/**
 * Spec 053 FR-007: at most this many ladder steps run after the first attempt (a step skipped for want of a candidate
 * does not count). Each step is a whole executor + critic run.
 */
export const MAX_LADDER_EXTRA_STEPS = 1;

/** Spec 053 FR-007: critic passes a slot used in its earlier attempts (the 15-minute retry included), from its trace. */
export function priorCriticPasses(fallback: SlotFallback | null | undefined): number {
  return (fallback?.steps ?? []).reduce((n, s) => n + (s.critic_passes ?? 0), 0);
}

/** Critic passes of the attempt whose verdict is stored on the slot (0 when the post never reached the critic). */
export function criticPasses(slot: { critic?: { history?: unknown[] | null } | null } | null | undefined): number {
  if (!slot?.critic) return 0;
  return 1 + (Array.isArray(slot.critic.history) ? slot.critic.history.length : 0);
}

const RESCUED = new Set(['published', 'shadowed', 'awaiting_approval', 'approved']);
export const isRescued = (status: string | null | undefined): boolean => !!status && RESCUED.has(status);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function detailsText(details: unknown): string {
  if (details == null) return '';
  if (Array.isArray(details)) return details.map((x: any) => (x && typeof x === 'object' ? x.code ?? x.message ?? JSON.stringify(x) : String(x))).join(', ');
  if (typeof details === 'object') return JSON.stringify(details);
  return String(details);
}

/**
 * What the publish tool saw in one run: its last error (lint, guard, critic_revise; null after a success) and the
 * source of the last post it was given (a rejected post is never stored on the slot, so the ladder learns it here).
 */
export class PublishProbe {
  last: { code: string; details: unknown } | null = null;
  source: string | null = null;

  wrap(tools: EditorTool[]): EditorTool[] {
    return tools.map((t) => (t.name !== 'publish_post' && t.name !== 'publish_platform_post') ? t : {
      ...t,
      execute: async (input: any, ctx: any) => {
        this.source = sourceOf(input?.spec) ?? this.source;
        const r = await t.execute(input, ctx);
        this.last = isToolError(r) ? { code: r.error, details: (r as any).details } : null;
        return r;
      },
    });
  }
}

/** The slot fields the classification reads. */
export interface SlotState {
  status:    string;
  error:     string | null;
  critic?:   {
    verdict?: string | null; notes?: string | null; scores?: Record<string, number | undefined> | null;
    /** Spec 067 A3: how much of the cited source the critic saw, and the numbers the code found in no text the author read. */
    source_coverage?: string | null; grounding_missing?: string[] | null;
  } | null;
  postSpec?: unknown;
}

/** Spec 063 FR-002: the critic or the executor says the post is not about the slot's topic (the material was not found). */
const WRONG_TOPIC_RE = /(?:не\s+про\s+(?:тему|матеріал|джерел)|(?:про|на)\s+ін(?:шу|ший|ша|шої|шого)\s+(?:тему|матеріал|новин|подію)|ін(?:ша|ший)\s+тем|не\s+та\s+тема|не\s+за\s+темою|поза\s+темою|тема\s+слота\s+не|wrong\s+topic|off[- ]topic)/iu;
export const isWrongTopic = (text: string | null | undefined): boolean => WRONG_TOPIC_RE.test(text ?? '');

/**
 * Spec 063 FR-002: is the critic's `revise` fixable on the same source? Review 3, slot 1fb75a76: the critic asked for
 * fixable edits and the ladder banned the very source («Не бери повторно») — a lost slot. A reject and a wrong topic
 * stay bans. Spec 067 A3: a grounding of 2 or less bans the source only when the critic saw the whole of it (`full`) and the
 * code check also listed numbers missing from it; a document the author read only in part, or a grounding 2 the code did
 * not confirm, is fixable (the fact may be elsewhere in the source). A critic stored before 067 has no coverage and keeps
 * the old rule.
 */
export function isFixableRevise(critic: SlotState['critic'] | undefined, extra?: string | null): boolean {
  if (critic?.verdict !== 'revise') return false;
  const grounding = critic.scores?.grounding;
  if (typeof grounding === 'number' && grounding <= 2) {
    const coverage = critic.source_coverage;
    if (coverage == null) return false;
    if (coverage === 'full' && critic.grounding_missing?.length) return false;
  }
  return !isWrongTopic(critic.notes) && !isWrongTopic(extra);
}

function sourceOf(spec: any): string | null {
  return typeof spec?.source?.url === 'string' ? spec.source.url : typeof spec?.library_ref === 'string' ? spec.library_ref : null;
}

/**
 * Did this attempt fail for a content reason the ladder retries? `probe` is the run's last publish-tool error: a
 * run that ran out of steps on a lint / guard error leaves the slot `running`.
 */
export function classifyFailure(slot: SlotState, run: Pick<PublishProbe, 'last' | 'source'> | null): SlotFailure | null {
  const f = classify(slot, run?.last ?? null);
  return f && !f.sourceUrl && run?.source ? { ...f, sourceUrl: run.source } : f;
}

function classify(slot: SlotState, probe: PublishProbe['last']): SlotFailure | null {
  const err = (slot.error ?? '').trim();
  const verdict = slot.critic?.verdict ?? null;
  const notes = slot.critic?.notes ?? null;
  if (slot.status === 'skipped' && /^critic_rejected\b/.test(err)) {
    return { kind: 'critic_reject', code: 'critic_rejected', reason: err, notes, sourceUrl: sourceOf(slot.postSpec), fixable: isFixableRevise(slot.critic, err) };
  }
  if (slot.status === 'skipped' && /^skipped by agent\b/.test(err) && (verdict === 'revise' || verdict === 'reject')) {
    // The critic asked for a rewrite and the executor gave up on it: a critic rejection, not an editorial choice.
    return { kind: 'critic_reject', code: 'critic_rejected', reason: `critic_rejected: executor skipped after revise — ${clip(notes ?? err, 300)}`, notes, sourceUrl: null, fixable: isFixableRevise(slot.critic, err) };
  }
  if (slot.status === 'failed' && /^lint_failed\b/.test(err)) {
    return { kind: 'lint', code: 'lint_failed', reason: err, notes: err, sourceUrl: null };
  }
  if (slot.status === 'running' && probe && isContentFailureCode(probe.code)) {
    const text = detailsText(probe.details);
    const kind = probe.code === 'lint_failed' ? 'lint' : 'guard';
    return {
      kind, code: probe.code,
      reason: clip(kind === 'lint' ? `lint_failed: ${text}` : `${probe.code}${text ? `: ${text}` : ''}`, 500),
      notes: clip(text, 600) || null, sourceUrl: null,
    };
  }
  return null;
}

/** Lighter formats, in order of preference (Telegram and native platform formats). */
export const LIGHTER_FORMATS: Record<string, string[]> = {
  longread: ['text', 'photo'], carousel: ['photo', 'text'], album: ['photo', 'text'], video: ['photo', 'text'],
  photo: ['text'], poll: ['text'], quiz: ['text'],
  ig_carousel: ['ig_photo'], fb_album: ['fb_photo', 'fb_text'], fb_photo: ['fb_text'], fb_link: ['fb_text'],
  th_carousel: ['th_image', 'th_text'], th_image: ['th_text'],
};

/** The first lighter format the resource allows (null: none — the step is not planned). */
export function lighterFormat(format: string, allowed: ReadonlySet<string>): string | null {
  return (LIGHTER_FORMATS[format] ?? []).find((f) => allowed.has(f)) ?? null;
}

/** The steps after the initial attempt (each at most once). */
export function ladderPlan(o: { format: string; allowed: ReadonlySet<string>; evergreen: boolean; live?: boolean; failure?: SlotFailure['kind']; fixable?: boolean }): Array<{ step: Exclude<LadderStep, 'initial'>; format: string }> {
  // Spec 063 FR-002: a fixable revise keeps its source; the next candidate is the step after it.
  const out: Array<{ step: Exclude<LadderStep, 'initial'>; format: string }> = [
    ...(o.fixable ? [{ step: 'revise_source' as const, format: o.format }] : []), { step: 'next_candidate', format: o.format },
  ];
  const lighter = lighterFormat(o.format, o.allowed);
  // Spec 053 FR-007: only one step runs — a post that failed lint tries the lighter format first.
  if (lighter) out[o.failure === 'lint' ? 'unshift' : 'push']({ step: 'lighter_format', format: lighter });
  // Spec 037 T10: the evergreen step (`fallbackEvergreen`, silent/evergreen.ts); plain text when allowed (no image needed).
  // Spec 046 FR-006: never for a live (news) slot — review 2: an evergreen glossary went out on a news channel.
  if (o.evergreen && !o.live) out.push({ step: 'evergreen', format: o.allowed.has('text') ? 'text' : lighter ?? o.format });
  return out;
}

/** The executor's extra instruction for a ladder step (Ukrainian: the executor's language). */
export function ladderNote(step: Exclude<LadderStep, 'initial'>, o: { failure: SlotFailure; format: string; original: string; avoid: string[]; live: boolean }): string {
  const why = o.failure.kind === 'critic_reject' ? 'критик відхилив пост' : o.failure.kind === 'lint' ? 'пост не пройшов lint' : `пост не пройшов перевірку (${o.failure.code})`;
  const lines = [`## Запасний крок (${step}): попередня спроба цього слота не вийшла — ${why}.`];
  if (o.failure.notes) lines.push(`Зауваження: ${clip(o.failure.notes, 600)}`);
  if (o.avoid.length) lines.push(`Не бери повторно: ${o.avoid.slice(0, 5).join('; ')}.`);
  if (step === 'revise_source') {
    // Spec 063 FR-002: the source is fine, the text is not.
    lines.push(`Матеріал і джерело ${o.failure.sourceUrl ? `(${o.failure.sourceUrl}) ` : ''}добрі: ЗАЛИШ ТОЙ САМИЙ матеріал і тему слота, перепиши пост і виправ саме ці зауваження. Не міняй джерело і не пиши про інше.`);
  } else if (step === 'next_candidate') {
    lines.push(o.live
      ? 'Візьми НАСТУПНИЙ свіжий матеріал зі списку (не той, що не пройшов) і напиши пост заново з урахуванням зауважень.'
      : 'Візьми ІНШИЙ матеріал чи джерело в межах теми слота (не той, що не пройшов) і напиши пост заново з урахуванням зауважень.');
  } else {
    lines.push(`Пиши в легшому форматі: ${o.format} замість ${o.original} — коротше і простіше, факти лише з прочитаних джерел.`);
    if (o.live) lines.push('Можна взяти інший свіжий матеріал, якщо він кращий.');
  }
  lines.push('Це запасна спроба: якщо гідного поста немає — skip_slot з причиною.');
  return lines.join('\n');
}

/** The outcome of one attempt from the slot after it (and its failure, if any). */
export function stepOutcome(slot: SlotState | null, failure: SlotFailure | null): StepOutcome {
  if (failure) return failure.kind;
  if (slot && isRescued(slot.status)) return slot.status as StepOutcome;
  return 'ended';
}

/** One step's record (verdict, cost, run) from the run result and the slot after it. */
export function stepRecord(
  step: LadderStep, format: string, at: Date, slot: (SlotState & { critic?: { verdict?: string | null; cost_usd?: number | null; cost_total_usd?: number | null } | null }) | null,
  failure: SlotFailure | null, run: { runId: string | null; totals?: { costUsd?: number } | null } | null,
): FallbackStepRecord {
  const outcome = stepOutcome(slot, failure);
  const reason = failure?.reason ?? (outcome === 'ended' ? (slot?.error ?? slot?.status ?? null) : null);
  return {
    step, at: at.toISOString(), format, outcome, reason: reason ? clip(reason, 300) : null,
    verdict: slot?.critic?.verdict ?? null, run_id: run?.runId ?? null,
    // Spec 041 FR-007: every critic pass of the step (cost_total_usd), not only the last one.
    cost_usd: Number(((run?.totals?.costUsd ?? 0) + Number(slot?.critic?.cost_total_usd ?? slot?.critic?.cost_usd ?? 0)).toFixed(6)),
    critic_passes: criticPasses(slot as { critic?: { history?: unknown[] | null } | null } | null),
    ...(failure?.sourceUrl || (slot?.postSpec && sourceOf(slot.postSpec)) ? { source_url: failure?.sourceUrl ?? sourceOf(slot!.postSpec) } : {}),
  };
}

/** The critic verdicts of a slot's attempts, oldest first (the reject streak reads them). */
export function attemptRejections(fallback: SlotFallback | null | undefined): boolean[] {
  return (fallback?.steps ?? [])
    .filter((s) => s.outcome !== 'no_candidate' && s.outcome !== 'unavailable')
    .filter((s) => s.verdict != null || s.outcome === 'critic_reject')
    .map((s) => s.outcome === 'critic_reject');
}
