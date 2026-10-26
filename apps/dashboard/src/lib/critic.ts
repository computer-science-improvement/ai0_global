// Spec 034 FR-004: the pre-publish critic's verdict as the dashboard shows it
// (approval card, chat draft card). Mirrors the backend's StoredCritic
// (apps/automation/src/editor/critic/critic.ts). Notes stay as the critic wrote them.

import type { Tone } from '../components/ui/primitives';

export type CriticVerdictKind = 'pass' | 'revise' | 'reject' | 'error';
// `owner_rules` (spec 040) is scored only when the channel has owner rules, so older verdicts lack it.
// `language` (spec 041) is absent on verdicts written before it.
export const CRITIC_SCORE_KEYS = ['ai_likeness', 'sense', 'voice', 'grounding', 'audience_asks', 'format_fit', 'language', 'owner_rules'] as const;
export type CriticScoreKey = typeof CRITIC_SCORE_KEYS[number];

/** Spec 067: one concrete remark of the critic; a blocking one with a quote found in the post sent the post back for a rewrite. */
export interface CriticIssue { quote?: string; fix: string; axis: CriticScoreKey; blocking: boolean }
/** Spec 067: how much of the cited source the critic was shown (the lowest among the cited sources). */
export type CriticCoverage = 'none' | 'snippet' | 'read' | 'full';

export interface CriticVerdict {
  verdict:        CriticVerdictKind;
  scores:         Partial<Record<CriticScoreKey, number>> | null;
  notes:          string;
  /** Ids of the owner rules the post broke (spec 040). */
  broken_rules?:  number[];
  model_verdict?: 'pass' | 'pass_with_edits' | 'revise' | 'reject' | null;
  /** Spec 041: exact replacements code applied before the post went out (critic edits, u/v fixes). */
  edits_applied?: Array<{ from: string; to: string }>;
  reason:         string;
  pass:           number;
  slop_warnings:  string[];
  model:          string | null;
  run_id:         string | null;
  cost_usd:       number;
  at:             string;
  final?:         boolean;
  /** Spec 067: the critic's remarks (≤ 8); older verdicts have none. */
  issues?:        CriticIssue[];
  /** Spec 067: pass 2 only, which numbered items of the first pass are fixed. */
  previous_checks?: Array<{ n: number; fixed: boolean }>;
  source_coverage?: CriticCoverage;
  /** Spec 067: numbers the code found in no text the author read. */
  grounding_missing?: string[];
  history?:       Array<{ verdict: CriticVerdictKind; scores: Partial<Record<CriticScoreKey, number>> | null; notes: string; reason: string; pass: number; at: string }>;
}

export const SCORE_LABEL: Record<CriticScoreKey, string> = {
  ai_likeness:   'Human voice',
  sense:         'Makes sense',
  voice:         'Tone',
  grounding:     'Grounded',
  audience_asks: 'Reader asks',
  format_fit:    'Format fit',
  language:      'Language',
  owner_rules:   'Your rules',
};

export const SCORE_HINT: Record<CriticScoreKey, string> = {
  ai_likeness:   '5 = reads like a person wrote it, 1 = obvious AI text',
  sense:         'Coherent, on topic, matches the source',
  voice:         "The resource's tone; jokes and slang only where allowed",
  grounding:     'Every fact is in the source',
  audience_asks: 'Questions to readers and polls fit (none is fine)',
  format_fit:    'The format and length suit the content and the platform',
  language:      'Correct Ukrainian: no russisms, calques or wrong cases',
  owner_rules:   "Keeps the channel's owner rules (scored only when the channel has rules)",
};

/** Badge copy and tone of a verdict ("Critic: pass"). */
export function verdictBadge(c: Pick<CriticVerdict, 'verdict' | 'final'>): { label: string; tone: Tone } {
  switch (c.verdict) {
    case 'pass':   return { label: 'Critic: pass', tone: 'success' };
    case 'revise': return { label: c.final ? 'Critic: revise (after one rewrite)' : 'Critic: revise', tone: 'warning' };
    case 'reject': return { label: 'Critic: reject', tone: 'danger' };
    default:       return { label: 'Critic: unavailable', tone: 'neutral' };
  }
}

/** Tone of one score: ≤ 2 is serious (`sense` rejects, any other axis sends the post back once), 3 asks for a rewrite. */
export function scoreTone(n: number): Tone {
  return n <= 2 ? 'danger' : n === 3 ? 'warning' : 'success';
}

/** The scores in display order (empty when the critic did not answer). */
export function scoreList(c: Pick<CriticVerdict, 'scores'>): Array<{ key: CriticScoreKey; label: string; hint: string; value: number; tone: Tone }> {
  if (!c.scores) return [];
  return CRITIC_SCORE_KEYS.filter((k) => typeof c.scores![k] === 'number')
    .map((k) => ({ key: k, label: SCORE_LABEL[k], hint: SCORE_HINT[k], value: c.scores![k]!, tone: scoreTone(c.scores![k]!) }));
}

/** Whether "Approve all" / the autonomy switch leave this post for a one-by-one decision. */
export function heldByCritic(c: Pick<CriticVerdict, 'verdict'> | null | undefined): boolean {
  return !!c && c.verdict !== 'pass';
}

/** Where a verdict is shown: an approval card, a chat draft, a written slot, or a slot's dry-run preview (spec 034 FR-012). */
export type CriticWhere = 'approval' | 'draft' | 'slot' | 'preview';

/** One explanatory line under the block. */
export function criticFootnote(c: Pick<CriticVerdict, 'verdict' | 'final' | 'pass'>, where: CriticWhere): string | null {
  if (where === 'draft') return 'Advisory: the critic never blocks your own publish.';
  if (where === 'preview') return 'The critic read this dry-run preview; the real post is reviewed again when it is written.';
  if (where === 'slot') return c.verdict === 'pass' && c.pass > 1 ? 'Passed after one rewrite.' : null;
  if (c.verdict === 'error') return 'The critic did not answer, so this post waits for you and is left out of "Approve all".';
  if (c.verdict === 'revise' && c.final) return 'The agent rewrote it once and the critic still asks for changes. Decide yourself; it is left out of "Approve all".';
  if (c.verdict === 'pass' && c.pass > 1) return 'Passed after one rewrite.';
  return null;
}

/** The critic's remarks for display: the ones that sent the post back first (spec 067); empty for verdicts written before it. */
export function issueList(c: Pick<CriticVerdict, 'issues'>): Array<CriticIssue & { label: string; tone: Tone; kind: string }> {
  return (c.issues ?? [])
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => Number(b.i.blocking) - Number(a.i.blocking) || a.idx - b.idx)
    .map(({ i }) => ({ ...i, label: SCORE_LABEL[i.axis] ?? i.axis, tone: i.blocking ? ('warning' as Tone) : ('neutral' as Tone), kind: i.blocking ? 'Must fix' : 'Advice' }));
}

/** What the critic could check the post against (spec 067), or null when it is unknown or nothing was read. */
export function coverageNote(c: Pick<CriticVerdict, 'source_coverage'>): string | null {
  switch (c.source_coverage) {
    case 'full':    return 'The critic saw the whole source page.';
    case 'read':    return 'The critic saw only the part of the document the agent read, so a fact it could not find may be elsewhere in it.';
    case 'snippet': return 'The critic saw only a feed snippet of the source.';
    default:        return null;
  }
}
