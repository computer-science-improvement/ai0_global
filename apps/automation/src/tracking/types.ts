// apps/automation/src/tracking/types.ts

/** A reference to another channel/account/URL extracted from a post body or metadata. */
export type AdRef =
  | { kind: 'tg_channel'; username: string; target_post_id?: number; forward?: boolean }
  | { kind: 'tg_user';    username: string; forward?: boolean }
  | { kind: 'tg_invite';  hash: string }
  | { kind: 'instagram';  username: string }
  | { kind: 'web';        domain: string };

/** BullMQ queue names. Kept as a const enum-ish object for type-safety. */
export const TRACKING_QUEUES = {
  POLL_META:          'tracking.poll-meta',
  POLL_POSTS:         'tracking.poll-posts',
  REFRESH_METRICS:    'tracking.refresh-metrics',
  RESOLVE_DISCOVERY:  'tracking.resolve-discovery',
} as const;

export type PollMetaJob          = { channelId: string };
export type PollPostsJob         = { channelId: string };
export type RefreshMetricsJob    = { postId: string };
/**
 * Discovery payload. For @username paths `username` is set; for
 * t.me/+invite paths `inviteHash` is set (and `username` is the literal
 * 'invite:<hash>' placeholder used for dedup). The worker branches on
 * which field is present.
 */
export type ResolveDiscoveryJob  = {
  username:         string;
  sourceChannelId:  string;
  inviteHash?:      string;
};

export type PollTier = 'hot' | 'warm' | 'cold';
