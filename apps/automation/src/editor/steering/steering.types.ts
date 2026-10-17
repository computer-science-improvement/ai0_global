/** Spec 045: steering — a reference resource that is not ours, learnt from, as the lowest-priority rule source of a target. */

export const STEERING_RULE_KINDS = ['structure', 'hook', 'length', 'formatting', 'cta', 'series', 'topic', 'mix'] as const;
export type SteeringRuleKind = typeof STEERING_RULE_KINDS[number];

/** Rules that describe what recurs in the reference need two posts behind them. */
export const MULTI_POST_KINDS: readonly SteeringRuleKind[] = ['series', 'topic', 'mix'];

export const PENDING_STATUSES = ['queued', 'collecting', 'analyzing', 'ready'] as const;
export type SteeringStatus =
  | typeof PENDING_STATUSES[number]
  | 'active' | 'paused' | 'discarded' | 'superseded' | 'failed' | 'no_access' | 'too_few_posts';

export const MAX_ACTIVE_SETS = 3;
export const MIN_RULES = 3;
export const MAX_RULES = 12;
export const RULE_TEXT_MAX = 300;
/** A rule describes, never quotes: no run this long shared with a reference post. */
export const RULE_QUOTE_MAX_CHARS = 60;
/** A post may not repeat a reference post's text this long (the library guard's limit, spec 004). */
export const POST_COPY_MAX_CHARS = 80;

export interface SteeringRule {
  id:       string;
  kind:     SteeringRuleKind;
  text:     string;
  evidence: { post_ids: string[]; note: string };
  /** What of the target's own rules it contradicts; such a rule is shown to the owner and never given to the agent. */
  conflict: { with: string; note: string } | null;
  enabled:  boolean;
  /** True once the owner rewrote the text. */
  edited?:  boolean;
}

/** One reference post in the snapshot (`r1` = the newest). The text is dropped once the set is closed. */
export interface SourcePost {
  key:       string;
  msgId:     number;
  postedAt:  string;
  text:      string;
  mediaType: string | null;
  views:     number | null;
  reactions: number | null;
  forwards:  number | null;
  comments:  number | null;
}

export interface SteeringSet {
  id:          string;
  targetRef:   string;
  channelKey:  string | null;
  sourceRef:   string;
  sourceTitle: string | null;
  status:      SteeringStatus;
  reason:      string | null;
  retryAt:     Date | null;
  posts:       SourcePost[];
  metrics:     unknown;
  summary:     string | null;
  rules:       SteeringRule[];
  runId:       string | null;
  costUsd:     number;
  createdBy:   string;
  createdAt:   Date;
  updatedAt:   Date;
  activatedAt: Date | null;
}

/** What the agent gets: the rules that steer it, by reference. */
export interface SteeringPromptRule { source: string; kind: SteeringRuleKind; text: string }
