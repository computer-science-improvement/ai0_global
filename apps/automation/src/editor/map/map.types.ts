import type { AgentKind, AgentMode, Platform } from '../agents/agent.types';

/**
 * Spec 056 FR-001: the network map snapshot — one JSON document the dashboard draws as a game map. Text is English
 * (the dashboard shows it). Post text never appears here: a post is named by its slot topic only.
 */

export const UNIT_STATES = ['idle', 'planning', 'writing', 'reviewing', 'waiting', 'publishing', 'error', 'paused', 'off'] as const;
export type UnitState = typeof UNIT_STATES[number];

export type ResourceHealthView = 'ok' | 'warning' | 'broken' | 'unknown';
/** A copy road is `duplicate` (a legacy network) or `adapt` (an independent one); a promo road is `promo` or, when all its traffic is reposts, `repost`. */
export type RoadKind = 'promo' | 'repost' | 'duplicate' | 'adapt';
/** What a road means (spec 058): the network's copy link, or a promo link the owner made. */
export type RoadRelation = 'network' | 'promo';

export const EVENT_KINDS = [
  'run_started', 'run_finished', 'run_failed', 'post_published', 'post_failed', 'post_approved', 'post_rejected', 'promo',
  'directive', 'launch_started', 'launch_graduated', 'link_made', 'link_broken', 'network_left',
] as const;
export type MapEventKind = typeof EVENT_KINDS[number];

/** How a network's resources share posts: each its own (independent) or the Telegram posts copied to all (legacy auto-duplicate). */
export type MapNetworkMode = 'independent' | 'legacy_duplicate';
export interface MapNetwork { id: string; name: string; anchorRef: string | null; mode: MapNetworkMode }

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
  /** How it runs: a Telegram channel's card mode, else its agent's effective mode; null without an agent. */
  mode:      AgentMode | null;
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

/**
 * A road is a current link between two resources (spec 058): the network's copy link (anchor → every other member) or a
 * promo link. `count30d` / `lastAt` are the traffic of the last 30 days (0 is fine: a new link has none yet). A `past`
 * road is activity of the last 30 days between two resources that are not linked any more; the map draws it on request.
 */
export interface MapRoad {
  from: string; to: string; kind: RoadKind; count30d: number; lastAt: string | null; joins30d: number | null;
  relation: RoadRelation;
  past: boolean;
  /** When the owner (or an approved promo) linked the pair; null for copy links and past roads. */
  linkedAt: string | null;
  /** A past promo road the owner broke (the manager does not propose the pair until it is linked again). */
  blocked: boolean;
}

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

/**
 * The connections a channel works through, which are not channels themselves: Telegram bots (they publish), MTProto
 * sessions (a user account that reads stats or writes DMs) and Telegraph accounts (long pages). Never a token, a session
 * string or a phone number.
 */
export type InfraKind = 'bot' | 'mtproto' | 'telegraph';

export interface MapInfra {
  /** `bot:<id>` · `mtproto:<id>` · `telegraph:<id>` (the row id; never a token). */
  id:        string;
  kind:      InfraKind;
  title:     string;
  /** The bot's or the session account's @username, the Telegraph author name. */
  username:  string | null;
  health:    ResourceHealthView;
  /** The last verify error in one line. */
  healthDetail: string | null;
  active:    boolean;
  /** The bot a channel without its own bot publishes through. */
  isDefault: boolean;
  /** An MTProto session's job: tracker (reads stats) or agent (DMs). */
  role:      string | null;
  /** The one the system uses: an active bot or Telegraph account, the first active session of its role (others stand by). */
  inUse:     boolean;
  lastVerifiedAt: string | null;
  /** The channels on the map it works for: a bot publishes to them (the default bot also to channels without a bot);
   *  the tracker session in use reads the stats of every Telegram channel. */
  serves:    string[];
  /** Where it is managed (Connections). */
  path:      string;
}

export interface MapBudget { spentUsd: number; capUsd: number | null; pct: number | null; blocking: boolean }

export interface MapSnapshot {
  generatedAt: string;
  budget:      MapBudget;
  /** Posts published and runs started today, for the top bar. */
  totals:      { runsToday: number; postsToday: number };
  networks:    MapNetwork[];
  resources:   MapResource[];
  infra:       MapInfra[];
  units:       MapUnit[];
  roads:       MapRoad[];
  alerts:      MapAlert[];
  events:      MapEvent[];
}
