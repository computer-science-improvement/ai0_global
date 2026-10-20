import type { ChannelLaunch, LaunchGraduation } from './launch.types';
import type { StepState } from './launch-checklist';

/**
 * Spec 052 FR-003: graduation from approval. The criteria count from Start; the numbers are a pure function of the
 * decided posts (oldest first), the critic verdicts and the channel's health, so the card, the checklist and the auto
 * switch read the same thing.
 */

export type GraduationMode = 'propose' | 'auto' | 'off';

export interface GraduationSettings {
  mode:        GraduationMode;
  minDays:     number;
  minApproved: number;
  minCleanPct: number;
  minCriticPct: number;
}

/** The last decisions that must hold no rejection. */
export const RECENT_DECISIONS = 5;
/** The critic rate needs at least this many verdicts. */
export const MIN_CRITIC_VERDICTS = 5;
/** "Not yet": wait this long and this many more approved posts. */
export const SNOOZE_DAYS = 7;
export const SNOOZE_MORE_APPROVED = 5;
/** A running launch is checked at most this often. */
export const GRADUATION_CHECK_MS = 60 * 60_000;

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v != null && v.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export function graduationSettings(env: (k: string) => string | undefined): GraduationSettings {
  const m = env('LAUNCH_GRADUATION')?.trim().toLowerCase();
  return {
    mode: m === 'auto' || m === 'off' ? m : 'propose',
    minDays: num(env('LAUNCH_GRADUATE_MIN_DAYS'), 7, 1, 60),
    minApproved: num(env('LAUNCH_GRADUATE_MIN_APPROVED'), 10, 1, 200),
    minCleanPct: num(env('LAUNCH_GRADUATE_MIN_CLEAN_PCT'), 80, 0, 100),
    minCriticPct: num(env('LAUNCH_GRADUATE_MIN_CRITIC_PCT'), 80, 0, 100),
  };
}

export type Decision = 'clean' | 'edited' | 'rejected' | 'expired';

export interface GraduationFacts {
  /** Owner decisions on the channel's posts since Start, oldest first (expired ones are not decisions). */
  decisions: Decision[];
  critic:    { pass: number; revise: number; reject: number };
  /** No blocking health state on the channel (049). */
  usable:    boolean;
}

export interface GraduationCriterion {
  key:   'days' | 'approved' | 'clean' | 'recent' | 'critic' | 'usable';
  ok:    boolean;
  /** English, for the dashboard. */
  label: string;
}

export interface GraduationStats {
  days:      number;
  approved:  number;
  clean:     number;
  rejected:  number;
  cleanPct:  number | null;
  criticPct: number | null;
  verdicts:  number;
  usable:    boolean;
  criteria:  GraduationCriterion[];
  met:       boolean;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

export function evaluateGraduation(f: GraduationFacts, s: GraduationSettings, startedAt: Date, now: Date): GraduationStats {
  const days = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000));
  const decided = f.decisions.filter((d) => d !== 'expired');
  const clean = decided.filter((d) => d === 'clean').length;
  const approved = clean + decided.filter((d) => d === 'edited').length;
  const rejected = decided.filter((d) => d === 'rejected').length;
  const cleanPct = pct(clean, approved);
  const verdicts = f.critic.pass + f.critic.revise + f.critic.reject;
  const criticPct = pct(f.critic.pass, verdicts);
  const recent = decided.slice(-RECENT_DECISIONS);
  const criteria: GraduationCriterion[] = [
    { key: 'days', ok: days >= s.minDays, label: `${Math.min(days, s.minDays)} of ${s.minDays} days in approval` },
    { key: 'approved', ok: approved >= s.minApproved, label: `${Math.min(approved, s.minApproved)} of ${s.minApproved} posts approved` },
    { key: 'clean', ok: approved > 0 && (cleanPct ?? 0) >= s.minCleanPct, label: `${cleanPct ?? '—'}% approved without edits (needs ${s.minCleanPct}%)` },
    { key: 'recent', ok: recent.length > 0 && !recent.includes('rejected'), label: recent.includes('rejected') ? `A rejection among the last ${RECENT_DECISIONS} decisions` : `No rejection among the last ${RECENT_DECISIONS} decisions` },
    {
      key: 'critic', ok: verdicts >= MIN_CRITIC_VERDICTS && (criticPct ?? 0) >= s.minCriticPct,
      label: verdicts < MIN_CRITIC_VERDICTS ? `Critic: ${verdicts} of ${MIN_CRITIC_VERDICTS} verdicts` : `Critic passes ${criticPct}% (needs ${s.minCriticPct}%)`,
    },
    { key: 'usable', ok: f.usable, label: f.usable ? 'The channel is healthy' : 'The channel has a connection problem' },
  ];
  return { days, approved, clean, rejected, cleanPct, criticPct, verdicts, usable: f.usable, criteria, met: criteria.every((c) => c.ok) };
}

/** Met, and not inside a "Not yet" snooze (its time and its extra approved posts). */
export function dueToGraduate(stats: GraduationStats, g: LaunchGraduation | null | undefined, now: Date): boolean {
  if (!stats.met) return false;
  if (g?.snoozedUntil && now.getTime() < new Date(g.snoozedUntil).getTime()) return false;
  if (g?.snoozedApproved != null && stats.approved < g.snoozedApproved) return false;
  return true;
}

/** The graduation line of the checklist. */
export function graduationStep(l: Pick<ChannelLaunch, 'status' | 'graduation'>, s: GraduationSettings, paused: boolean): { state: StepState; detail: string } | null {
  if (l.status !== 'running') return null;
  const g = l.graduation;
  const st = g?.stats as GraduationStats | null | undefined;
  if (paused) return { state: 'waiting', detail: 'Paused: the channel is off' };
  if (g?.proposedAt && !g.decidedAt) return { state: 'needs_you', detail: 'Ready: press Go live, or Not yet to wait a week more' };
  const missing = st ? st.criteria.filter((c) => !c.ok).map((c) => c.label) : [];
  const mode = s.mode === 'off' ? 'Automatic graduation is off; ' : s.mode === 'auto' ? 'Goes live by itself when ready; ' : '';
  const snooze = g?.snoozedUntil ? `Not yet until ${new Date(g.snoozedUntil).toISOString().slice(0, 10)}${g.snoozedApproved != null ? ` and ${g.snoozedApproved} approved posts` : ''}. ` : '';
  return { state: 'waiting', detail: `${snooze}${mode}${st ? (missing.length ? missing.join(' · ') : 'all criteria met') : 'checked hourly'}` };
}

/** The numbers in one Ukrainian line (owner bot card, the auto note). */
export function graduationLineUk(st: GraduationStats): string {
  return [
    `${st.days} дн. у схваленні`,
    `схвалено ${st.approved}`,
    st.cleanPct != null ? `без правок ${st.cleanPct}%` : null,
    st.criticPct != null ? `критик пропускає ${st.criticPct}% (${st.verdicts})` : null,
  ].filter(Boolean).join(' · ');
}
