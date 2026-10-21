/**
 * Spec 059: what the probe of a skill self-edit leaves on the version row (`skill_versions.probe`, migration 092).
 *
 *   probing        written, not live: the previous version is still what the agents read;
 *   adopted        the probe found the new text no worse and better often enough → live, under the 7-day KPI review;
 *   rejected       the probe found it worse → never live, the agent keeps an `avoid` memory line;
 *   inconclusive   not enough evidence either way (or the budget ran out) → live as before, under the KPI review;
 *   unprobed       nothing to probe on (no samples, the skill is not read by the writer, probes off) → live as before;
 *   owner_override the owner adopted a rejected version anyway;
 *   superseded     a newer proposal or an owner edit replaced it before the probe finished.
 */
export type ProbeVerdict = 'probing' | 'adopted' | 'rejected' | 'inconclusive' | 'unprobed' | 'owner_override' | 'superseded';

/** The critic's verdict of one side, or why there is none. */
export type SideCritic = 'pass' | 'pass_with_edits' | 'revise' | 'reject';

/** One side (old or new skill text) of a sample: the dry-run post and the code signals. */
export interface ProbeSide {
  /** The critic's last verdict on the dry-run post. */
  critic:  SideCritic;
  /** Lint warnings of the post (count). */
  lint:    number;
  /** Characters of the reader-visible text (0 when the critic stopped the post). */
  chars:   number;
  /** The post as the preview renders it (≤ 600 characters); null when the critic stopped it. */
  preview: string | null;
}

export type JudgeBetter = 'old' | 'new' | 'same';

export interface ProbeJudgement {
  better:  JudgeBetter;
  reasons: string[];
  risks:   string[];
  /** 'judge' = the pairwise model call; 'code' = decided without a call (one side has no post, or they are equal). */
  by:      'judge' | 'code';
}

export interface ProbeSample {
  slotId: string;
  topic:  string;
  old:    ProbeSide;
  new:    ProbeSide;
  judge:  ProbeJudgement;
}

export interface ProbeRecord {
  verdict:  ProbeVerdict;
  /** Why (no samples, probes off, the budget ran out, the decision line). */
  reason?:  string;
  samples:  ProbeSample[];
  /** Slots that were picked but gave no usable pair (a side failed, was skipped or the critic did not answer). */
  dropped?: number;
  costUsd:  number;
  /** ISO time the probe was decided (or the version was written, while probing). */
  at:       string;
}

/** A skill version row's probe as the UI reads it (everything optional: old rows have none). */
export const emptyProbe = (verdict: ProbeVerdict, reason: string | undefined, at: Date): ProbeRecord => ({
  verdict, ...(reason ? { reason } : {}), samples: [], costUsd: 0, at: at.toISOString(),
});
