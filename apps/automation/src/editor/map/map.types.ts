import type { AgentKind, AgentMode, Platform } from '../agents/agent.types';

/**
 * Spec 056 FR-001: the network map snapshot — one JSON document the dashboard draws as a game map. Text is English
 * (the dashboard shows it). Post text never appears here: a post is named by its slot topic only.
 */

export const UNIT_STATES = ['idle', 'planning', 'writing', 'reviewing', 'waiting', 'publishing', 'error', 'paused', 'off'] as const;
export type UnitState = typeof UNIT_STATES[number];

export type ResourceHealthView = 'ok' | 'warning' | 'broken' | 'unknown';
export type RoadKind = 'promo' | 'repost' | 'duplicate';

export const EVENT_KINDS = [
  'run_started', 'run_finished', 'run_failed', 'post_published', 'post_failed', 'post_approved', 'post_rejected', 'promo',
  'directive', 'launch_started', 'launch_graduated',
] as const;
export type MapEventKind = typeof EVENT_KINDS[number];

export interface MapNetwork { id: string; name: string; anchorRef: string | null }

export interface MapResource {
  ref:       string;
  platform:  Platform;
  title:     string | null;
  username:  string | null;
  followers: number | null;
  groupId:   string | null;
  health:    ResourceHealthView;
  /** The connection problem in one line (token expired, no access…), when there is one. */
  healthDetail: string | null;
  paused:    boolean;
  postsToday: number;
  /** Posts waiting for the owner's approval. */
  waiting:   number;
  /** The @handle of the agent that runs it. */
  agent:     string | null;
}

/** How the level is made (FR-005): the numbers of the last 30 days. */
export interface LevelStats { clean: number; pass: number; rejected: number; failedRuns: number; score: number }

export interface MapUnit {
  id:            string;
  handle:        string;
  name:          string;
  kind:          AgentKind;
  emoji:         string | null;
  parentId:      string | null;
  /** The building the unit stands next to (null for the headquarters). */
  homeRef:       string | null;
  mode:          AgentMode;
  effectiveMode: AgentMode;
  state:         UnitState;
  stateSince:    string | null;
  detail:        string | null;
  spentTodayUsd: number;
  capUsd:        number | null;
  runsToday:     number;
  lastRunAt:     string | null;
  /** 1–10, quality-based; null for the system agents. */
  level:         number | null;
  levelStats:    LevelStats | null;
}

export interface MapRoad { from: string; to: string; kind: RoadKind; count30d: number; lastAt: string | null; joins30d: number | null }

export interface MapAlert {
  /** approval · directive · connection · stuck · launch */
  kind:  string;
  count: number;
  ref:   string | null;
  agent: string | null;
  title: string;
  path:  string;
}

export interface MapEvent {
  /** Stable across polls: the client animates only ids it has not seen. */
  id:    string;
  at:    string;
  kind:  MapEventKind;
  agent: string | null;
  ref:   string | null;
  /** The other end of a promo / repost. */
  toRef?: string | null;
  text:  string;
}

export interface MapBudget { spentUsd: number; capUsd: number | null; pct: number | null; blocking: boolean }

export interface MapSnapshot {
  generatedAt: string;
  budget:      MapBudget;
  /** Posts published and runs started today, for the top bar. */
  totals:      { runsToday: number; postsToday: number };
  networks:    MapNetwork[];
  resources:   MapResource[];
  units:       MapUnit[];
  roads:       MapRoad[];
  alerts:      MapAlert[];
  events:      MapEvent[];
}
