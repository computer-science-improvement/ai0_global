/**
 * Spec 052: a channel launch — a new channel from a brief and 1–3 references, through a checklist of what only the owner
 * can do, a Start into approval mode and the graduation to live.
 */

export const LAUNCH_STATUSES = ['queued', 'preparing', 'analyzing', 'ready', 'running', 'graduated', 'failed', 'discarded'] as const;
export type LaunchStatus = typeof LAUNCH_STATUSES[number];

/** One open launch per channel (the partial unique index of 086). */
export const OPEN_LAUNCH_STATUSES: readonly LaunchStatus[] = ['queued', 'preparing', 'analyzing', 'ready', 'running'];
/** Before Start: the launch may be redone with a new brief or discarded with its card left `off`. */
export const PRE_START_STATUSES: readonly LaunchStatus[] = ['queued', 'preparing', 'analyzing', 'ready', 'failed'];

export const MAX_REFERENCES = 3;
export const MIN_BRIEF_CHARS = 30;
export const MAX_BRIEF_CHARS = 4000;

/** A reference channel of the launch and the steering set (045) that reads it. */
export interface LaunchRef {
  ref:    string;
  setId:  string | null;
  /** The steering set's status when the launch last looked (`skipped` = it could not be read). */
  status: string;
  reason: string | null;
  title:  string | null;
}

/** The owner's decision on graduation and the last numbers it was based on (FR-003). */
export interface LaunchGraduation {
  proposedAt?:      string | null;
  snoozedUntil?:    string | null;
  /** Approved posts when the owner said "Not yet": the next proposal needs 5 more. */
  snoozedApproved?: number | null;
  decidedAt?:       string | null;
  by?:              'owner' | 'auto' | 'owner_elsewhere' | null;
  checkedAt?:       string | null;
  stats?:           unknown;
  /** The channel was switched back to off after Start (shown as paused; the launch keeps running). */
  paused?:          boolean;
}

/** One promo filed for the launch (FR-004). */
export interface LaunchPromoItem {
  sourceRef:   string;
  directiveId: string | null;
  slotId:      string | null;
  at:          string | null;
  error:       string | null;
}

export interface LaunchPromo {
  filedAt: string;
  items:   LaunchPromoItem[];
  /** Why no source fits, when none does. */
  note:    string | null;
}

/** The last Bot API check of the channel (FR-002 `bot_admin`). */
export interface LaunchBotState {
  state:  'ok' | 'no_access' | 'token_invalid' | 'unknown';
  detail: string;
  bot:    string | null;
  chatTitle?: string | null;
  chatAbout?: string | null;
}

export interface ChannelLaunch {
  id:             string;
  channelKey:     string;
  targetRef:      string;
  title:          string | null;
  brief:          string;
  refs:           LaunchRef[];
  status:         LaunchStatus;
  reason:         string | null;
  retryAt:        Date | null;
  plan:           unknown;
  checklist:      unknown;
  startRequested: boolean;
  startedAt:      Date | null;
  graduation:     LaunchGraduation;
  promo:          LaunchPromo | null;
  subsAtStart:    number | null;
  botCheckedAt:   Date | null;
  botState:       LaunchBotState | null;
  agentId:        string | null;
  runId:          string | null;
  costUsd:        number;
  createdBy:      string;
  createdAt:      Date;
  updatedAt:      Date;
  graduatedAt:    Date | null;
}
