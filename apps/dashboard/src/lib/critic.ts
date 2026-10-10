// Spec 034 FR-004: the pre-publish critic's verdict as the dashboard shows it
// (approval card, chat draft card). Mirrors the backend's StoredCritic
// (apps/automation/src/editor/critic/critic.ts). Notes stay as the critic wrote them.

import type { Tone } from '../components/ui/primitives';

export type CriticVerdictKind = 'pass' | 'revise' | 'reject' | 'error';
export const CRITIC_SCORE_KEYS = ['ai_likeness', 'sense', 'voice', 'grounding', 'audience_asks', 'format_fit'] as const;
export type CriticScoreKey = typeof CRITIC_SCORE_KEYS[number];

export interface CriticVerdict {
  verdict:        CriticVerdictKind;
  scores:         Record<CriticScoreKey, number> | null;
  notes:          string;
  model_verdict?: 'pass' | 'revise' | 'reject' | null;
  reason:         string;
  pass:           number;
  slop_warnings:  string[];
  model:          string | null;
  run_id:         string | null;
  cost_usd:       number;
  at:             string;
  final?:         boolean;
  history?:       Array<{ verdict: CriticVerdictKind; scores: Record<CriticScoreKey, number> | null; notes: string; reason: string; pass: number; at: string }>;
}

export const SCORE_LABEL: Record<CriticScoreKey, string> = {
  ai_likeness:   'Human voice',
  sense:         'Makes sense',
  voice:         'Tone',
  grounding:     'Grounded',
  audience_asks: 'Reader asks',
  format_fit:    'Format fit',
};

export const SCORE_HINT: Record<CriticScoreKey, string> = {
  ai_likeness:   '5 = reads like a person wrote it, 1 = obvious AI text',
  sense:         'Coherent, on topic, matches the source',
  voice:         "The resource's tone; jokes and slang only where allowed",
  grounding:     'Every fact is in the source',
  audience_asks: 'Questions to readers and polls fit (none is fine)',
  format_fit:    'The format and length suit the content and the platform',
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

/** Tone of one score: ≤ 2 rejects, 3 asks for a rewrite (the backend thresholds). */
export function scoreTone(n: number): Tone {
  return n <= 2 ? 'danger' : n === 3 ? 'warning' : 'success';
}

/** The scores in display order (empty when the critic did not answer). */
export function scoreList(c: Pick<CriticVerdict, 'scores'>): Array<{ key: CriticScoreKey; label: string; hint: string; value: number; tone: Tone }> {
  if (!c.scores) return [];
  return CRITIC_SCORE_KEYS.filter((k) => typeof c.scores![k] === 'number')
    .map((k) => ({ key: k, label: SCORE_LABEL[k], hint: SCORE_HINT[k], value: c.scores![k], tone: scoreTone(c.scores![k]) }));
}

/** Whether "Approve all" / the autonomy switch leave this post for a one-by-one decision. */
export function heldByCritic(c: Pick<CriticVerdict, 'verdict'> | null | undefined): boolean {
  return !!c && c.verdict !== 'pass';
}

/** One explanatory line under the block. */
export function criticFootnote(c: Pick<CriticVerdict, 'verdict' | 'final' | 'pass'>, where: 'approval' | 'draft'): string | null {
  if (where === 'draft') return 'Advisory: the critic never blocks your own publish.';
  if (c.verdict === 'error') return 'The critic did not answer, so this post waits for you and is left out of "Approve all".';
  if (c.verdict === 'revise' && c.final) return 'The agent rewrote it once and the critic still asks for changes. Decide yourself; it is left out of "Approve all".';
  if (c.verdict === 'pass' && c.pass > 1) return 'Passed after one rewrite.';
  return null;
}
