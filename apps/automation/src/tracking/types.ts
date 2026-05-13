// apps/automation/src/tracking/types.ts

/** A reference to another channel/account/URL extracted from a post body or metadata. */
export type AdRef =
  | { kind: 'tg_channel'; username: string; target_post_id?: number; forward?: boolean }
  | { kind: 'tg_user';    username: string; forward?: boolean }
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
export type ResolveDiscoveryJob  = { username: string; sourceChannelId: string };

export type PollTier = 'hot' | 'warm' | 'cold';
