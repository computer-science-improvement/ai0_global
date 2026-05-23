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
  /** Strategies that publish to this channel (primary binding) or forward
   *  into it from another channel. Empty array when none. */
  strategies?: ChannelStrategyRef[];
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
