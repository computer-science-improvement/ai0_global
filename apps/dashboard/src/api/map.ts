import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { pollInterval } from '../lib/map-diff';

// Spec 056: GET /api/map — the whole network in one snapshot (resources, agents with a derived state, roads, alerts, events).

export const UNIT_STATES = ['idle', 'planning', 'writing', 'reviewing', 'waiting', 'publishing', 'error', 'paused', 'off'] as const;
export type UnitState = typeof UNIT_STATES[number];

export type MapPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok' | 'youtube';
export type MapAgentKind = 'manager' | 'builder' | 'orchestrator' | 'planner' | 'ideator' | 'idea_reviewer' | 'executor' | 'reviewer';
export type MapMode = 'off' | 'shadow' | 'approve' | 'live';
export type MapHealth = 'ok' | 'warning' | 'broken' | 'unknown';
/** A copy road of a network is `duplicate` (Auto-duplicate) or `adapt` (Independent); a promo road is `promo`, or `repost` when all its traffic is reposts. */
export type RoadKind = 'promo' | 'repost' | 'duplicate' | 'adapt';
/** What a road means (spec 058): the network's copy link, or a promo link the owner made. */
export type RoadRelation = 'network' | 'promo';

export type MapEventKind =
  | 'run_started' | 'run_finished' | 'run_failed' | 'post_published' | 'post_failed' | 'post_approved' | 'post_rejected' | 'promo'
  | 'directive' | 'launch_started' | 'launch_graduated' | 'link_made' | 'link_broken' | 'network_left';

/** How a network's resources share posts: each its own, or the Telegram posts copied to all (legacy auto-duplicate). */
export type MapNetworkMode = 'independent' | 'legacy_duplicate';
export interface MapNetwork { id: string; name: string; anchorRef: string | null; mode?: MapNetworkMode }

export interface MapResource {
  ref: string; platform: MapPlatform; title: string | null; username: string | null; followers: number | null; groupId: string | null;
  health: MapHealth; healthDetail: string | null; paused: boolean; postsToday: number; waiting: number; agent: string | null;
  /** How it runs: the Telegram card's mode, else its agent's; null without an agent (absent from an older server). */
  mode?: MapMode | null;
}

/** Spec 056 follow-up: what a channel works through — Telegram bots, MTProto sessions, Telegraph accounts (never a token or a phone). */
export type InfraKind = 'bot' | 'mtproto' | 'telegraph';
export interface MapInfra {
  id: string; kind: InfraKind; title: string; username: string | null; health: MapHealth; healthDetail: string | null; active: boolean;
  isDefault: boolean; role: string | null; inUse?: boolean; lastVerifiedAt: string | null; serves: string[]; path: string;
}

export interface LevelStats { clean: number; pass: number; rejected: number; failedRuns: number; score: number }

export interface MapUnit {
  id: string; handle: string; name: string; kind: MapAgentKind; emoji: string | null; parentId: string | null; homeRef: string | null;
  mode: MapMode; effectiveMode: MapMode; state: UnitState; stateSince: string | null; detail: string | null;
  spentTodayUsd: number; capUsd: number | null; runsToday: number; lastRunAt: string | null;
  level: number | null; levelStats: LevelStats | null;
}

/**
 * A road is a current link (spec 058): the network's copy link (anchor → member) or a promo link. `count30d` is the traffic
 * of the last 30 days, 0 for a link with no traffic yet. A `past` road is activity of the last 30 days between two
 * resources that are not linked any more; the map draws it only on request. The three new fields are absent from an older server.
 */
export interface MapRoad {
  from: string; to: string; kind: RoadKind; count30d: number; lastAt: string | null; joins30d: number | null;
  relation?: RoadRelation;
  past?: boolean;
  linkedAt?: string | null;
  /** A past promo road the owner broke: the manager does not propose the pair until it is linked again. */
  blocked?: boolean;
}

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

/**
 * The map snapshot, polled: every page that reads it (the map, Today's Live activity) shares one cache entry and one
 * timer. 5 s while any unit works, 30 s otherwise, and none while the tab is hidden (spec 056 FR-004); coming back
 * refetches at once.
 */
export function useMapSnapshot() {
  return useQuery({
    queryKey: MAP_KEY,
    queryFn: mapApi.snapshot,
    refetchInterval: (query) => pollInterval(query.state.data, typeof document !== 'undefined' && document.hidden),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Spec 056 follow-up: move a resource into a network, or out of any (groupId null). 409 when the network has one of that platform. */
export function useSetResourceNetwork() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (b: { ref: string; groupId: string | null }) =>
      api<{ ref: string; groupId: string | null; groupName: string | null; canceled?: number }>('/api/map/resource-network', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MAP_KEY });
      void qc.invalidateQueries({ queryKey: ['meta-account-groups'] });
    },
  });
}

/** Block (or allow again) promos between two resources, both ways; blocking skips their promo posts not yet out. */
export function useSetPromoBlock() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (b: { a: string; b: string; blocked: boolean }) =>
      api<{ a: string; b: string; blocked: boolean; canceled: number }>('/api/map/promo-block', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: MAP_KEY }),
  });
}

/** Spec 058: link a resource with others and break its links (promo links, both ways). Returns what actually changed. */
export interface SetLinksBody { ref: string; add: string[]; remove: string[] }
export interface SetLinksResult { ref: string; linked: string[]; unlinked: string[]; canceled: number }
export function useSetLinks() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (b: SetLinksBody) => api<SetLinksResult>('/api/map/links', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: MAP_KEY }),
  });
}

/** Spec 058: put several resources in a network and take several out. Partial success: each ref has its own result. */
export interface MemberResult { ref: string; ok: boolean; error?: string }
export interface SetMembersBody { groupId: string; add: string[]; remove: string[] }
export interface SetMembersResult { groupId: string; groupName: string; results: MemberResult[]; canceled: number }
export function useSetNetworkMembers() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (b: SetMembersBody) => api<SetMembersResult>('/api/map/network-members', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MAP_KEY });
      void qc.invalidateQueries({ queryKey: ['meta-account-groups'] });
    },
  });
}
