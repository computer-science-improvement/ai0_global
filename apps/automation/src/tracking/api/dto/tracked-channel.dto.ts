export interface TrackedChannelDto {
  id: string;
  username: string | null;
  title: string | null;
  about: string | null;
  subsCount: number | null;
  isMine: boolean;
  isClosed: boolean;
  /** MTProto session reachability. 'not_subscribed' → dashboard prompts the
   *  operator to subscribe the tracking account so polling can resume. */
  trackingStatus: 'unknown' | 'ok' | 'not_subscribed';
  pollTier: 'hot' | 'warm' | 'cold';
  addedAt: string;
  lastPolledAt: string | null;
  /** Phase 5a config columns surfaced for the dashboard. */
  channelKey:   string | null;
  /** Numeric Telegram chat id (-100…). Required for private channels. */
  tgChatId:     string | null;
  kind:         string | null;
  botId:        string | null;
  /** Brand group (meta_account_groups) this channel belongs to; null = none. */
  groupId:      string | null;
  /** Per-channel publishing kill switch. When true, all strategies + forwards
   *  into this channel are blocked at publish time. */
  publishPaused: boolean;
  /** Denormalized bot identity (joined via my_bots). null when no bot bound. */
  bot:          ChannelBotRef | null;
  /** True when this channel has no bot bound AND no default bot exists — the UI
   *  prompts the operator to bind a bot or set a default. */
  needsBot:     boolean;
  themes:       string[];
  /** Strategies that publish to this channel (primary binding) or forward
   *  into it from another channel. Empty array when none. */
  strategies?: ChannelStrategyRef[];
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
  /** 'primary' = strategy fires directly into this channel.
   *  'forward' = strategy fires into a different channel that forwards here. */
  role:    'primary' | 'forward';
}
