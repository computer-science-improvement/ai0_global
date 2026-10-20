// Spec 052 FR-005: the launch panel's wording — checklist states, the plan's numbers, growth and graduation.
import type { Tone } from '../components/ui/primitives';

export type StepState = 'done' | 'waiting' | 'needs_you' | 'skipped' | 'failed' | 'optional';

export interface LaunchStep {
  key:    string;
  who:    'owner' | 'code';
  state:  StepState;
  title:  string;
  detail: string | null;
  link:   string | null;
}

export interface LaunchPlan {
  summary: string;
  brief_profile: { brief: string; profile: { topic?: string; audience?: { who?: string }; language?: string; tone?: string | null; goals?: string[]; taboo?: string[] } };
  format_mix: { formats: Record<string, number> };
  series_pillars: { series: Array<{ name: string; cadence: string; format: string; brief: string }>; pillars: Array<{ name: string; share: number }> };
  schedule: { posts_per_day_min: number; posts_per_day_max: number; quiet_start_hour: number | null; quiet_end_hour: number | null; best_hours: number[] };
  voice: { description: string; rules: string[] };
  first_week: { ideas: Array<{ day: number; title: string; angle: string; format: string; intro: boolean }> };
  references: Array<{ ref: string; takeaway: string }>;
}

export interface GraduationCriterion { key: string; ok: boolean; label: string }

export interface LaunchView {
  id: string; channelKey: string; title: string | null; brief: string; status: string; reason: string | null;
  refs: Array<{ ref: string; name: string; status: string; reason: string | null }>;
  plan: LaunchPlan | null;
  startRequested: boolean; startedAt: string | null;
  graduation: { proposedAt?: string | null; decidedAt?: string | null; by?: string | null; snoozedUntil?: string | null; paused?: boolean; stats?: { criteria?: GraduationCriterion[]; days?: number; approved?: number; cleanPct?: number | null; criticPct?: number | null; verdicts?: number } | null };
  promo: { filedAt: string; note: string | null; items: Array<{ sourceRef: string; slotId: string | null; at: string | null; error: string | null }> } | null;
  bot: { state: string; detail: string; bot: string | null; checkedAt: string | null } | null;
  costUsd: number; createdAt: string; graduatedAt: string | null;
  checklist: LaunchStep[];
  growth: { subsAtStart: number | null; subsNow: number | null; published: number; promoJoins: number } | null;
}

const TONE: Record<StepState, Tone> = { done: 'success', needs_you: 'warning', failed: 'danger', waiting: 'neutral', skipped: 'neutral', optional: 'neutral' };
const LABEL: Record<StepState, string> = { done: 'done', needs_you: 'needs you', failed: 'failed', waiting: 'waiting', skipped: 'skipped', optional: 'optional' };

export const stepTone = (s: StepState): Tone => TONE[s] ?? 'neutral';
export const stepLabel = (s: StepState): string => LABEL[s] ?? s;

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** The format mix as whole percentages that add up to 100, biggest first. */
export function mixRows(formats: Record<string, number>): Array<{ format: string; pct: number }> {
  const entries = Object.entries(formats).filter(([, w]) => w > 0);
  const sum = entries.reduce((a, [, w]) => a + w, 0);
  if (!sum) return [];
  const rows = entries.map(([format, w]) => ({ format, exact: (w / sum) * 100 }));
  const out = rows.map((r) => ({ format: r.format, pct: Math.floor(r.exact) }));
  let left = 100 - out.reduce((a, r) => a + r.pct, 0);
  // Largest remainders get the leftover points.
  for (const i of rows.map((r, i) => ({ i, rem: r.exact - Math.floor(r.exact) })).sort((a, b) => b.rem - a.rem).map((x) => x.i)) {
    if (left <= 0) break;
    out[i].pct++;
    left--;
  }
  return out.sort((a, b) => b.pct - a.pct || a.format.localeCompare(b.format));
}

export function scheduleLine(s: LaunchPlan['schedule']): string {
  const rate = s.posts_per_day_min === s.posts_per_day_max ? `${s.posts_per_day_max}` : `${s.posts_per_day_min}–${s.posts_per_day_max}`;
  const parts = [`${rate} post${s.posts_per_day_max === 1 ? '' : 's'} a day`];
  if (s.quiet_start_hour != null && s.quiet_end_hour != null) parts.push(`quiet ${hh(s.quiet_start_hour)}–${hh(s.quiet_end_hour)}`);
  if (s.best_hours.length) parts.push(`best at ${[...s.best_hours].sort((a, b) => a - b).map(hh).join(', ')}`);
  return parts.join(' · ');
}

/** Subscribers now against Start: "+12" / "−3" / "" without numbers. */
export function subsDelta(g: NonNullable<LaunchView['growth']>): string {
  if (g.subsNow == null || g.subsAtStart == null) return '';
  const d = g.subsNow - g.subsAtStart;
  return d === 0 ? 'no change' : `${d > 0 ? '+' : '−'}${Math.abs(d)} since Start`;
}

export const isExternal = (link: string) => /^https?:\/\//.test(link);

/** Waiting for the owner now: the header line of the panel. */
export function launchHeadline(v: LaunchView): string | null {
  if (v.status === 'ready' && v.startRequested) return 'Start is pressed: the launch begins as soon as the bot is an administrator.';
  if (v.status === 'ready') return 'The plan is ready. Read it, then press Start.';
  if (v.status === 'running' && v.graduation?.proposedAt && !v.graduation.decidedAt) return 'The agent writes well enough to go live.';
  if (v.status === 'running' && v.graduation?.paused) return 'The channel is off: the launch is paused.';
  if (v.status === 'running') return 'Posts wait for your approval while the agent learns the channel.';
  if (v.status === 'graduated') return 'Live: posts go out without approval.';
  if (['queued', 'preparing', 'analyzing'].includes(v.status)) return 'Reading the references and making the plan — a few minutes.';
  return null;
}
