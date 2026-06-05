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
  bot?:          ChannelBotRef | null;
  themes?:       string[];
  /** Per-channel publishing kill switch. When true, all publishes are blocked. */
  publishPaused?: boolean;
  strategies?:   ChannelStrategyRef[];
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
  schedule:     string;
  params:       Record<string, unknown>;
  enabled:      boolean;
  notes:        string | null;
  /** ISO timestamp of the next scheduled fire, or null if cron invalid / disabled. */
  next_run_at:  string | null;
  last_run:     StrategyRunSummary | null;
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
