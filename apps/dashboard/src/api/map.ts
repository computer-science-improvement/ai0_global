import { api } from './client';

// Spec 056: GET /api/map — the whole network in one snapshot (resources, agents with a derived state, roads, alerts, events).

export const UNIT_STATES = ['idle', 'planning', 'writing', 'reviewing', 'waiting', 'publishing', 'error', 'paused', 'off'] as const;
export type UnitState = typeof UNIT_STATES[number];

export type MapPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok' | 'youtube';
export type MapAgentKind = 'manager' | 'builder' | 'orchestrator' | 'planner' | 'ideator' | 'idea_reviewer' | 'executor' | 'reviewer';
export type MapMode = 'off' | 'shadow' | 'approve' | 'live';
export type MapHealth = 'ok' | 'warning' | 'broken' | 'unknown';
export type RoadKind = 'promo' | 'repost' | 'duplicate';

export type MapEventKind =
  | 'run_started' | 'run_finished' | 'run_failed' | 'post_published' | 'post_failed' | 'post_approved' | 'post_rejected' | 'promo'
  | 'directive' | 'launch_started' | 'launch_graduated';

export interface MapNetwork { id: string; name: string; anchorRef: string | null }

export interface MapResource {
  ref: string; platform: MapPlatform; title: string | null; username: string | null; followers: number | null; groupId: string | null;
  health: MapHealth; healthDetail: string | null; paused: boolean; postsToday: number; waiting: number; agent: string | null;
}

/** Spec 056 follow-up: what a channel works through — Telegram bots, MTProto sessions, Telegraph accounts (never a token or a phone). */
export type InfraKind = 'bot' | 'mtproto' | 'telegraph';
export interface MapInfra {
  id: string; kind: InfraKind; title: string; username: string | null; health: MapHealth; healthDetail: string | null; active: boolean;
  isDefault: boolean; role: string | null; lastVerifiedAt: string | null; serves: string[]; path: string;
}

export interface LevelStats { clean: number; pass: number; rejected: number; failedRuns: number; score: number }

export interface MapUnit {
  id: string; handle: string; name: string; kind: MapAgentKind; emoji: string | null; parentId: string | null; homeRef: string | null;
  mode: MapMode; effectiveMode: MapMode; state: UnitState; stateSince: string | null; detail: string | null;
  spentTodayUsd: number; capUsd: number | null; runsToday: number; lastRunAt: string | null;
  level: number | null; levelStats: LevelStats | null;
}

export interface MapRoad { from: string; to: string; kind: RoadKind; count30d: number; lastAt: string | null; joins30d: number | null }

export interface MapAlert { kind: string; count: number; ref: string | null; agent: string | null; title: string; path: string }

export interface MapEvent { id: string; at: string; kind: MapEventKind; agent: string | null; ref: string | null; toRef?: string | null; text: string }

export interface MapSnapshot {
  generatedAt: string;
  budget: { spentUsd: number; capUsd: number | null; pct: number | null; blocking: boolean };
  totals: { runsToday: number; postsToday: number };
  networks: MapNetwork[];
  resources: MapResource[];
  /** Absent from a server older than the infra sections. */
  infra?: MapInfra[];
  units: MapUnit[];
  roads: MapRoad[];
  alerts: MapAlert[];
  events: MapEvent[];
}

export const MAP_KEY = ['map'] as const;

export const mapApi = {
  snapshot: () => api<MapSnapshot>('/api/map'),
};
