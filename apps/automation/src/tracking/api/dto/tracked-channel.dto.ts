export interface TrackedChannelDto {
  id: string;
  username: string | null;
  title: string | null;
  about: string | null;
  subsCount: number | null;
  isMine: boolean;
  isClosed: boolean;
  pollTier: 'hot' | 'warm' | 'cold';
  addedAt: string;
  lastPolledAt: string | null;
  /** Phase 5a config columns surfaced for the dashboard. */
  channelKey:   string | null;
  /** Numeric Telegram chat id (-100…). Required for private channels. */
  tgChatId:     string | null;
  kind:         string | null;
  botId:        string | null;
  /** Denormalized bot identity (joined via my_bots). null when no bot bound. */
  bot:          ChannelBotRef | null;
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
