// Spec 034 FR-006 (T4): the content-quality block of the MANAGER's digest as the
// Network health card shows it — critic pass rate, polls against the weekly cap,
// reader questions, the owner's rejections and edits, the code's quality flags.
// Mirrors ResourceQuality (apps/automation/src/editor/manager/quality-digest.ts).
// Pure helpers, no React and no runtime imports (the node:test suite loads this).

export type QualityTone = 'neutral' | 'success' | 'warning' | 'danger';

export const QUALITY_FLAGS = [
  'critic_reject', 'critic_low_pass', 'critic_failed', 'polls_over_cap', 'reader_questions_over_cap', 'owner_rejections', 'owner_edits',
  // Spec 037 FR-010: silent days.
  'dark_day', 'series_missed',
  // Spec 037 FR-009: a feed that mostly gives jargon over the audience level or critic revise / reject.
  'feed_misfit',
] as const;
export type QualityFlag = typeof QUALITY_FLAGS[number];

export interface QualitySample { at: string; status: string; format: string; text: string }

export interface ResourceQuality {
  days:  number;
  posts: number;
  critic: {
    pass: number; revise: number; reject: number; failed: number; total: number; revised_then_passed: number;
    pass_rate: number | null; mean: Record<string, number> | null; notes: string[];
  };
  polls: { count: number; slots: number; share: number | null; cap: number | null; over: boolean };
  reader_questions: { cap: number; with_questions: number; over_cap: number; examples: string[] };
  owner: { approved: number; edited: number; rejected: number; rejection_rate: number | null; reasons: string[]; edits: string[] };
  samples: QualitySample[];
  /** Spec 037 FR-010: planned vs out per local day (absent on older digests). */
  plan?: {
    days: Array<{ day: string; planned: number; published: number; shadowed: number; pending: number; skip_reasons: Record<string, number>; rescued: number }>;
    dark_days: string[];
    series_missed: Array<{ day: string; slot_id: string; series: string; status: string; reason: string }>;
    fallback: { laddered: number; rescued: number };
  };
  /** Spec 037 FR-009: per feed, items with jargon over the audience level / critic revise / reject (absent on older digests). */
  feeds?: Array<{ feed: string; items: number; jargon_over_level: number; revise: number; reject: number; misfit_share: number; suggestion: 'replace' | 'limit' | null }>;
  flags: QualityFlag[];
}

/** The manager's per-resource answer to the quality checklist (manager_reviews.quality_check). */
export interface QualityCheckEntry {
  resource_ref: string;
  status:       'ok' | 'issue';
  evidence:     string;
  issues:       string[];
  note?:        string;
}

export const FLAG_LABEL: Record<QualityFlag, string> = {
  critic_reject:             'critic rejected posts',
  critic_low_pass:           'low critic pass rate',
  critic_failed:             'critic unavailable',
  polls_over_cap:            'polls over the cap',
  reader_questions_over_cap: 'too many reader questions',
  owner_rejections:          'you rejected posts',
  owner_edits:               'you edited posts',
  dark_day:                  'a planned day with no post',
  series_missed:             'a series slot did not go out',
  feed_misfit:               'a feed does not fit the audience',
};

export const CHECK_ITEM_LABEL: Record<string, string> = {
  ai_likeness: 'sounds like AI', sense: 'sense', voice: 'voice / humour', audience_asks: 'polls & questions', owner_feedback: 'your feedback', format_fit: 'format fit', silent_days: 'silent days',
};

export const flagLabel = (f: string) => FLAG_LABEL[f as QualityFlag] ?? f.replace(/_/g, ' ');

const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);

export interface QualityStat { key: 'critic' | 'polls' | 'owner'; label: string; value: string; tone: QualityTone; title: string }

/** Has the block anything to show (posts, verdicts, owner decisions or planned slots)? */
export function qualityActive(q: ResourceQuality | null | undefined): q is ResourceQuality {
  return !!q && (q.posts > 0 || q.critic.total > 0 || q.owner.approved + q.owner.rejected > 0 || q.polls.slots > 0);
}

/** The three numbers of a resource tile: critic pass rate, polls vs cap, owner rejections. */
export function qualityStats(q: ResourceQuality): QualityStat[] {
  const judged = q.critic.pass + q.critic.revise + q.critic.reject;
  const passTone: QualityTone = judged === 0 ? 'neutral' : q.critic.reject > 0 || (q.critic.pass_rate ?? 1) < 0.7 ? 'danger' : (q.critic.pass_rate ?? 1) < 0.9 ? 'warning' : 'success';
  const cap = q.polls.cap;
  const pollTone: QualityTone = q.polls.over ? 'danger' : q.polls.count > 0 && cap != null && q.polls.count === cap ? 'warning' : 'neutral';
  const ownerTone: QualityTone = q.owner.rejected > 0 ? 'danger' : q.owner.edited > 0 ? 'warning' : q.owner.approved > 0 ? 'success' : 'neutral';
  return [
    {
      key: 'critic', label: 'Critic pass', value: judged ? pct(q.critic.pass_rate) : '—', tone: passTone,
      title: `Critic over ${q.days} days: ${q.critic.pass} pass · ${q.critic.revise} revise · ${q.critic.reject} reject${q.critic.failed ? ` · ${q.critic.failed} unavailable` : ''}${q.critic.revised_then_passed ? ` (${q.critic.revised_then_passed} passed after one rewrite)` : ''}`,
    },
    {
      key: 'polls', label: 'Polls / cap', value: `${q.polls.count} / ${cap == null ? '∞' : cap}`, tone: pollTone,
      title: `Poll and quiz posts in ${q.days} days (planned included) against the weekly cap${cap == null ? ' (no cap)' : ''}; ${pct(q.polls.share)} of the slots`,
    },
    {
      key: 'owner', label: 'Your rejections', value: `${q.owner.rejected}${q.owner.edited ? ` · ${q.owner.edited} edited` : ''}`, tone: ownerTone,
      title: `Approval mode, ${q.days} days: ${q.owner.approved} approved (${q.owner.edited} edited), ${q.owner.rejected} rejected`,
    },
  ];
}

/** One line for a collapsed tile: the worst signals first. */
export function qualityHeadline(q: ResourceQuality | null | undefined): { text: string; tone: QualityTone } {
  if (!qualityActive(q)) return { text: 'No posts in 7 days', tone: 'neutral' };
  if (!q.flags.length) return { text: 'No quality flags', tone: 'success' };
  const bad = q.flags.some((f) => f === 'critic_reject' || f === 'critic_low_pass' || f === 'polls_over_cap' || f === 'owner_rejections' || f === 'dark_day');
  return { text: q.flags.map(flagLabel).join(' · '), tone: bad ? 'danger' : 'warning' };
}

/** Network totals for the card header: resources with quality flags. */
export function flaggedCount(resources: ReadonlyArray<{ quality?: ResourceQuality | null }>): number {
  return resources.filter((r) => (r.quality?.flags.length ?? 0) > 0).length;
}
