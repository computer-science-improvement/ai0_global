// Read-only queries for the network-digest strategy: what OUR channels
// published in the window, the freshest view counts per post, and the
// network-wide subscriber delta. No writes — the digest owns no tables.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { digestPostsInWindow, DigestPostRow } from '../../common/digests/digest-selection';

export type { DigestPostRow } from '../../common/digests/digest-selection';

@Injectable()
export class NetworkDigestRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Posts our own channels published in the last `windowHours`, joined with
   * the channel's username (for t.me links) and the LATEST view snapshot.
   * Digest posts themselves are excluded so today's digest never advertises
   * yesterday's digest, and paid ad posts (strategy_type 'ad') are never
   * re-promoted for free. `published_posts.channel_id` stores the channel_key.
   * The query is shared with get_network_highlights (src/common/digests, spec 023).
   */
  async postsInWindow(windowHours: number, includeChannels?: string[]): Promise<DigestPostRow[]> {
    return digestPostsInWindow(this.pool, { windowHours, channels: includeChannels, ownWithViews: true, order: 'newest' });
  }

  /**
   * Network-wide subscriber delta over the window: per channel, latest
   * snapshot minus the earliest snapshot inside the window, summed. Channels
   * with fewer than two snapshots contribute 0.
   */
  async subsDelta(windowHours: number): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(delta), 0) AS total FROM (
         SELECT (MAX(subscribers) FILTER (WHERE rn_desc = 1)
               - MAX(subscribers) FILTER (WHERE rn_asc = 1)) AS delta
           FROM (
             SELECT channel_id, subscribers,
                    ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY captured_at DESC) AS rn_desc,
                    ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY captured_at ASC)  AS rn_asc
               FROM channel_stats_snapshots
              WHERE captured_at >= now() - ($1 || ' hours')::interval
                AND subscribers IS NOT NULL
           ) x
          GROUP BY channel_id
          HAVING COUNT(*) >= 2
       ) d`,
      [windowHours],
    );
    return Number(r.rows[0]?.total ?? 0);
  }
}
