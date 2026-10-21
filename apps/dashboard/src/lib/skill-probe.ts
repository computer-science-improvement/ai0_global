// Spec 059: how the dashboard reads the probe of a skill self-edit. Pure helpers, no React: the badge of a version,
// the tally line, the side-by-side rows of the dialog, and the short "why" of a memory line that came from a probe
// rejection or a KPI rollback. Everything tolerates a server that sends no `probe` (older rows, older servers).

import type { ProbeCritic, ProbeRecord, ProbeSample, SkillVersion } from '../api/agents';

export type ProbeTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

export interface ProbeBadgeInfo { label: string; tone: ProbeTone; title: string }

type VersionLike = Pick<SkillVersion, 'outcome'> & { probe?: ProbeRecord | null };

/**
 * The probe badge of a version, or null when it has nothing to say (a version made before probes, one replaced before
 * its probe ran, a plain owner edit). `Probing…` and `Rejected by probe` come from the version's state, the others
 * from the stored record.
 */
export function probeBadge(v: VersionLike): ProbeBadgeInfo | null {
  if (v.outcome === 'probing') return { label: 'Probing…', tone: 'warning', title: 'Being tried on recent posts; the previous text is still live' };
  if (v.outcome === 'rejected') return { label: 'Rejected by probe', tone: 'danger', title: v.probe?.reason ?? 'The probe found the new text worse; it never went live' };
  const verdict = v.probe?.verdict;
  switch (verdict) {
    case 'adopted': return { label: 'Adopted after probe', tone: 'success', title: v.probe?.reason ?? 'The probe found the new text no worse and better often enough' };
    case 'owner_override': return { label: 'Adopted anyway', tone: 'accent', title: v.probe?.reason ?? 'Rejected by the probe, adopted by you' };
    case 'inconclusive': return { label: 'Inconclusive', tone: 'neutral', title: v.probe?.reason ?? 'The probe could not tell; the edit went live as before' };
    case 'unprobed': return { label: 'Unprobed', tone: 'neutral', title: v.probe?.reason ?? 'The edit went live without a probe' };
    default: return null;
  }
}

export const probeTally = (samples: readonly ProbeSample[]) => ({
  wins: samples.filter((s) => s.judge.better === 'new').length,
  ties: samples.filter((s) => s.judge.better === 'same').length,
  losses: samples.filter((s) => s.judge.better === 'old').length,
});

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "The new text won 2, tied 1, lost 0 of 3 posts · $0.12". Null when there is nothing to count. */
export function probeSummary(p: ProbeRecord | null | undefined): string | null {
  if (!p || !p.samples?.length) return null;
  const t = probeTally(p.samples);
  return `The new text won ${t.wins}, tied ${t.ties}, lost ${t.losses} of ${plural(p.samples.length, 'post')} · ${usd(p.costUsd ?? 0)}`;
}

/** Whether the dialog has anything to show: samples, or at least a reason. */
export const hasProbeDetails = (v: VersionLike): boolean => !!v.probe && (v.probe.samples?.length > 0 || !!v.probe.reason);

/** "Adopt anyway" is offered for the newest version only, and only while it is rejected. */
export function canAdoptAnyway(v: Pick<SkillVersion, 'outcome' | 'version'>, all: ReadonlyArray<Pick<SkillVersion, 'version'>>): boolean {
  return v.outcome === 'rejected' && all.every((x) => x.version <= v.version);
}

export const CRITIC_LABEL: Record<ProbeCritic, string> = { pass: 'Pass', pass_with_edits: 'Pass with edits', revise: 'Revise', reject: 'Reject' };
export const criticTone = (c: ProbeCritic): ProbeTone => (c === 'pass' ? 'success' : c === 'pass_with_edits' ? 'neutral' : c === 'revise' ? 'warning' : 'danger');

export const BETTER_LABEL = { new: 'New text is better', old: 'Old text is better', same: 'About equal' } as const;
export const betterTone = (b: ProbeSample['judge']['better']): ProbeTone => (b === 'new' ? 'success' : b === 'old' ? 'danger' : 'neutral');

/**
 * The short "why" of a memory line written by the system, from its evidence: a probe rejection (the tally and the
 * judge's first reason) or a KPI rollback (the change in views per post). Null for every other memory line.
 */
export function memoryWhy(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const e = evidence as Record<string, unknown>;
  const skill = typeof e.skill === 'string' ? `"${e.skill}"` : 'the skill';
  const ver = typeof e.version === 'number' ? ` v${e.version}` : '';
  if (e.source === 'skill_probe') {
    const n = (k: string) => (typeof e[k] === 'number' ? (e[k] as number) : 0);
    const tally = `new text won ${n('wins')}, tied ${n('ties')}, lost ${n('losses')}`;
    const first = Array.isArray(e.why) && typeof e.why[0] === 'string' ? ` · ${e.why[0]}` : '';
    return `Probe rejected ${skill}${ver}: ${tally}${first}`;
  }
  if (e.source === 'kpi_rollback') {
    const d = typeof e.deltaPct === 'number' ? `views per post ${e.deltaPct.toFixed(0)}%` : 'views fell';
    return `Rolled back ${skill}${ver} after the 7-day KPI review: ${d}`;
  }
  return null;
}
