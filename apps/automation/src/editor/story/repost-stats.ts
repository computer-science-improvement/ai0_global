/**
 * Spec 037 T2: reposts (native forwards of a sibling's post: spec 022 repost, T2 story_repost — published_posts
 * strategy_type 'repost') are counted apart from own posts. The MANAGER's quality block shows the share and flags a
 * resource whose reposts are more than 30 % of what it put out (it lives off its siblings).
 */

export const REPOST_SHARE_MAX = 0.3;

export interface RepostShare {
  own:     number;
  reposts: number;
  /** reposts / (own + reposts); null without posts. */
  share:   number | null;
  /** share > 30 %. */
  over:    boolean;
}

export function repostShare(own: number, reposts: number): RepostShare {
  const total = own + reposts;
  const share = total > 0 ? Math.round((reposts / total) * 1000) / 1000 : null;
  return { own, reposts, share, over: share != null && share > REPOST_SHARE_MAX };
}

/** SQL: own vs repost publications per `telegram:<channel>` ref in [$2, $3) (ads are neither). */
export const REPOST_COUNTS_SQL = `SELECT 'telegram:' || channel_id AS ref,
        COUNT(*) FILTER (WHERE strategy_type = 'repost')::int AS reposts,
        COUNT(*) FILTER (WHERE COALESCE(strategy_type, '') NOT IN ('repost', 'ad'))::int AS own
   FROM published_posts
  WHERE 'telegram:' || channel_id = ANY($1::text[]) AND posted_at >= $2 AND posted_at < $3
  GROUP BY 1`;
