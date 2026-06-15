// publish-destination.ts — the resolved target a strategy publishes to.
import type { MetaPlatform } from '../../config/meta-accounts.repository';

export type DestinationPlatform = 'telegram' | MetaPlatform | 'tiktok';

export interface PublishDestination {
  /** 'telegram' = TG channel; otherwise a Meta platform. */
  platform: DestinationPlatform;
  /** TG channel_key, or the Meta account's publishable target id. */
  targetId: string;
  /** Resolved access token (Meta only; undefined for Telegram). */
  token?: string;
  /** Meta account UUID (null for Telegram). */
  metaAccountId: string | null;
  /** Dedup key written into the `posted` JSONB: 'TELEGRAM' | 'IG:<uuid>' | 'FB:<uuid>' | 'TH:<uuid>'. */
  postedKey: string;
  /** Posting-throttle key: TG channel_key, or 'meta:<uuid>'. */
  throttleKey: string;
}

/** Prefix for a Meta destination's per-account dedup key. */
export const META_POSTED_PREFIX: Record<MetaPlatform, string> = {
  instagram: 'IG',
  facebook:  'FB',
  threads:   'TH',
};
