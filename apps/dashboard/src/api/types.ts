export interface TrackedChannel {
  id: string;
  username: string | null;
  title: string | null;
  about: string | null;
  subsCount: number | null;
  isMine: boolean;
  isClosed: boolean;
  trackingStatus: 'unknown' | 'ok' | 'not_subscribed';
  pollTier: 'hot' | 'warm' | 'cold';
  addedAt: string;
  lastPolledAt: string | null;
  channelKey?:   string | null;
  kind?:         string | null;
  /** Numeric Telegram chat id (-100…). Required for private channels. */
  tgChatId?:     string | null;
  botId?:        string | null;
  /** Brand group (meta_account_groups) this channel belongs to; null = none. */
  groupId?:      string | null;
  bot?:          ChannelBotRef | null;
  themes?:       string[];
  /** Per-channel publishing kill switch. When true, all publishes are blocked. */
  publishPaused?: boolean;
  strategies?:   ChannelStrategyRef[];
  /** True when this channel has no bot bound AND no default bot exists. */
  needsBot?:     boolean;
}

export interface ChannelBotRef {
  id:       string;
  bot_id:   string;
  username: string | null;
  active:   boolean;
}

export interface ChannelStrategyRef {
  id:      string;
  ext_id:  string;
  type:    string;
  enabled: boolean;
  role:    'primary' | 'forward';
}

export interface TrackedPost {
  id: string;
  channelId: string;
  tgMessageId: string;
  text: string | null;
  hasMedia: boolean;
  postedAt: string;
  views: number | null;
  forwards: number | null;
  reactionsTotal: number | null;
  commentsCount: number | null;
  adRefs: unknown[] | null;
}

export interface SubsHistoryPoint { at: string; subs: number; }
export interface PageResp<T> { items: T[]; total: number; }

export interface Me { tgUserId: number; firstName: string; username?: string; }

export interface GraphNode {
  id: string; username: string | null; title: string | null;
  subs: number | null; isMine: boolean; category: string | null;
}
export interface GraphEdge {
  source: string; target: string | null; target_username: string;
  count: number; kind: string; colorTier: 'green' | 'orange' | 'red'; last_seen: string;
}
export interface GraphResponse { nodes: GraphNode[]; edges: GraphEdge[]; }

export interface RoiResponse {
  estimated_subs_per_ad: number;
  confidence: 'low' | 'medium' | 'high';
  narrative: string;
  risks: string[];
  source: 'heuristic' | 'claude';
  computed_at: string;
  inputs: { avg_views: number; subs: number; engagement_rate: number };
}

// ─── Phase 4: Discovery / Recommendations ─────────────────────────────────

export interface Theme {
  slug:  string;
  title: string;
}

export interface RecommendationItem {
  id:                 string;
  slug:               string;
  link:               string;
  title:              string;
  description:        string | null;
  themes:             string[];
  matchedThemes:      string[];
  score:              number;
  estimatedSubsPerAd: number | null;
  roiConfidence:      string | null;
  priceMin:           number;
  priceMax:           number | null;
  sexRatio:           number | null;
  avatarUrl:          string | null;
  language:           string | null;
  source:             string;
}

export interface RecommendResponse {
  recommendations: RecommendationItem[];
  targetThemes:    string[];
  warning?:        string;
}

export interface Bot {
  id:               string;
  bot_id:           string;
  username:         string | null;
  first_name:       string | null;
  platform:         string;
  token_env:        string;
  active:           boolean;
  /** At most one bot is the default — used as a fallback publisher for channels with no bot. */
  is_default:       boolean;
  last_verified_at: string | null;
  verify_error:     string | null;
  created_at:       string;
}

export interface TgAccountInfo {
  id:        string | null;
  username:  string | null;
  firstName: string | null;
  lastName:  string | null;
  phone:     string | null;
  isPremium: boolean;
}

export interface TrackingSession {
  id:          string;
  label:       string;
  /** Which .env var holds the session string in effect. */
  envVar:      string;
  /** True when both API creds and a session string are present. */
  configured:  boolean;
  /** True when the MTProto client actually connected at boot. */
  ready:       boolean;
  /** True when reusing the shared publisher session instead of a dedicated one. */
  shared:      boolean;
  hasApiCreds: boolean;
  /** The real Telegram account behind this session, when connected. */
  account:     TgAccountInfo | null;
}

export interface TrackingSessionsResponse { sessions: TrackingSession[]; }

/** A dashboard-managed MTProto session stored ENCRYPTED in the DB. The session
 *  string itself is never returned by the API — only safe display fields. */
export interface MtprotoSession {
  id:               string;
  label:            string;
  active:           boolean;
  username:         string | null;
  phone:            string | null;
  tg_user_id:       string | null;
  /** Telegram app id (api_id). Not secret; null when relying on the env fallback. */
  api_id:           string | null;
  /** True when this session carries its own encrypted app credentials. */
  has_api_creds:    boolean;
  last_verified_at: string | null;
  verify_error:     string | null;
  created_at:       string;
}

export interface TelegraphAccount {
  id:               string;
  account_id:       string;
  token_env:        string;
  short_name:       string | null;
  author_name:      string | null;
  author_url:       string | null;
  active:           boolean;
  last_verified_at: string | null;
  verify_error:     string | null;
  created_at:       string;
}

// ─── Phase 5c: Strategies ──────────────────────────────────────────────────

export interface Strategy {
  id:           string;
  ext_id:       string;
  type:         string;
  channel_id:   string;
  /** Denormalized channel_key (e.g. "@motivation_local") for UI display. */
  channel_key:  string | null;
  /** All channels this strategy reaches: primary + forward targets. */
  channels:     StrategyChannelRef[];
  /** Destination kind of this binding: 'telegram' | 'instagram' | 'facebook' | 'threads'. */
  platform:     string;
  /** Meta account this binding publishes to natively (null for telegram bindings). */
  meta_account: { id: string; platform: string; username: string | null } | null;
  /** Platforms shown as icons / used for tab grouping. Telegram binding: 'telegram' + cross-post targets. Native-Meta binding: just its own platform. */
  platforms:    string[];
  schedule:     string;
  params:       Record<string, unknown>;
  enabled:      boolean;
  notes:        string | null;
  /** ISO timestamp of the next scheduled fire, or null if cron invalid / disabled. */
  next_run_at:  string | null;
  last_run:     StrategyRunSummary | null;
  /** Remaining unpublished posts for finite-pool strategies; null for live/feed types. */
  content_remaining:     number | null;
  /** Effective low-content alert threshold (posts); binding override or default 100. */
  low_content_threshold: number;
  /** True for a telegram binding whose channel has no bot AND no default bot exists. */
  needs_bot?:            boolean;
}

export interface StrategyChannelRef {
  id:          string;
  channel_key: string | null;
  title:       string | null;
  role:        'primary' | 'forward';
}

export interface StrategyRunSummary {
  status:       'running' | 'ok' | 'error' | 'skipped';
  started_at:   string;
  finished_at:  string | null;
  duration_ms:  number | null;
  error:        string | null;
}

export interface StrategyRun {
  id:           string;
  strategy_id:  string;
  ext_id:       string;
  started_at:   string;
  finished_at:  string | null;
  status:       'running' | 'ok' | 'error' | 'skipped';
  error:        string | null;
  duration_ms:  number | null;
}

// ─── Strategy preview (sample of what the strategy would publish) ──────────

export interface PreviewItem {
  title?:       string;
  text?:        string;
  imageUrl?:    string;
  imageAlt?:    string;
  source?:      string;
  url?:         string;
  publishedAt?: string;
}

export interface StrategyPreview {
  /** db-row = sampled row from a Postgres table feeding this strategy.
   *  dedup-recent = last N items the dedup layer marked as posted.
   *  live-fetch = strategy fetches at runtime (e.g. NASA APOD); preview unavailable.
   *  unsupported = strategy type unknown or has no preview source wired. */
  kind:    'db-row' | 'dedup-recent' | 'live-fetch' | 'unsupported';
  message?: string;
  items:   PreviewItem[];
}

// ─── Scheduled posts (operator-composed one-off Telegram posts) ─────────────

export type SchedSender = 'bot' | 'mtproto_user';
export type SchedMedia  = 'none' | 'photo' | 'video';
export type SchedPlacement = 'above' | 'below';
export interface SchedButtonRow { buttons: { label: string; url: string }[]; }

export interface ComposedPostInput {
  channelId: string; sender: SchedSender; botId: string | null;
  text: string; mediaType: SchedMedia; mediaUrl: string | null;
  mediaPlacement: SchedPlacement; buttons: SchedButtonRow[]; scheduledAt: string;
}
export interface ScheduledPost extends ComposedPostInput {
  id: string; status: 'pending'|'sending'|'sent'|'failed'|'canceled';
  messageId: number | null; error: string | null; createdAt: string; updatedAt: string;
}

// ─── App settings (read-only mirror of server .env) ─────────────────────────

export interface AppSettings {
  telegram: {
    trackingEnabled:      boolean;
    /** Owner chat id for admin notifications; '' when unset. */
    ownerId:              string;
    trackingShareSession: boolean;
    statsPostAgeDays:     number;
    postingCooldownMin:   number;
    fetchTimeoutMs:       number;
  };
  ai: {
    anthropic:  boolean;
    perplexity: boolean;
    openai:     boolean;
    grok:       boolean;
  };
  /** Env keys whose value comes from a DB override (set via the dashboard). */
  overrides: string[];
}

export type MetaPlatform = 'instagram' | 'facebook' | 'threads';

export interface MetaAccount {
  id:               string;
  platform:         MetaPlatform;
  account_id:       string;
  token_env:        string;
  target_id:        string;
  username:         string | null;
  display_name:     string | null;
  followers:        number | null;
  followers_delta_24h: number | null;
  picture_url:      string | null;
  active:           boolean;
  last_verified_at: string | null;
  verify_error:     string | null;
  created_at:       string;
  /** Meta account group (brand FB/IG/Threads link for publish fan-out); null = ungrouped. */
  group_id:         string | null;
  // Derived access-token metadata (debug_token) — never the token value itself.
  token_type:                   string | null;
  token_expires_at:             string | null;
  token_data_access_expires_at: string | null;
  token_scopes:                 string[] | null;
  /** debug_token is_valid; null = never checked (token_checked_at is null). */
  token_valid:                  boolean | null;
  token_checked_at:             string | null;
}

export type CrosspostMode = 'mirror' | 'teaser';

export interface CrosspostTarget {
  id:              string;
  channel_id:      string;
  platform:        MetaPlatform;
  meta_account_id: string;
  mode:            CrosspostMode;
  enabled:         boolean;
  created_at:      string;
}

export type ActivityType = 'posted' | 'error' | 'skipped' | 'running';

export interface ActivityEvent {
  id:         string;
  at:         string;
  source:     'strategy_run' | 'scheduled_post';
  type:       ActivityType;
  status:     string;
  channelId:  string | null;
  channel:    string | null;
  strategyId: string | null;
  strategy:   string | null;
  detail:     string | null;
  durationMs: number | null;
}

export interface ActivityListResult {
  items:   ActivityEvent[];
  hasMore: boolean;
  total:   number;
}

/** One step in a strategy run's execution trace (strategy_runs.steps). */
export interface RunStep {
  seq:        number;
  service:    string;
  action:     string;
  status:     'ok' | 'error' | 'skipped';
  durationMs: number;
  detail?:    string;
  error?:     string;
}

export interface SettingsPatch {
  trackingEnabled?:      boolean;
  telegramOwnerId?:      string;
  trackingShareSession?: boolean;
  statsPostAgeDays?:     number;
  postingCooldownMin?:   number;
  fetchTimeoutMs?:       number;
}
