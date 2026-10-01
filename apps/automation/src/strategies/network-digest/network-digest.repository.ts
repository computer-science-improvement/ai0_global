// Read-only queries for the network-digest strategy: what OUR channels
// published in the window, the freshest view counts per post, and the
// network-wide subscriber delta. No writes — the digest owns no tables.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface DigestPostRow {
  channelKey: string;
  username:   string | null;
  messageId:  number;
  title:      string;
  views:      number | null;
  postedAt:   Date;
  /** published_posts.strategy_type — drives digestTitle() cleanup. */
  strategyType?: string | null;
}

@Injectable()
export class NetworkDigestRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Posts our own channels published in the last `windowHours`, joined with
   * the channel's username (for t.me links) and the LATEST view snapshot.
   * Digest posts themselves are excluded so today's digest never advertises
   * yesterday's digest, and paid ad posts (strategy_type 'ad') are never
   * re-promoted for free. `published_posts.channel_id` stores the channel_key.
   */
  async postsInWindow(windowHours: number, includeChannels?: string[]): Promise<DigestPostRow[]> {
    const args: unknown[] = [windowHours];
    let channelFilter = '';
    if (includeChannels && includeChannels.length > 0) {
      args.push(includeChannels);
      channelFilter = `AND p.channel_id = ANY($${args.length})`;
    }
    const r = await this.pool.query(
      `SELECT p.channel_id                 AS channel_key,
              tc.username                  AS username,
              p.message_id                 AS message_id,
              COALESCE(p.title, '')        AS title,
              s.views                      AS views,
              p.posted_at                  AS posted_at,
              p.strategy_type              AS strategy_type
         FROM published_posts p
         JOIN tracked_channels tc
           ON tc.channel_key = p.channel_id AND tc.is_mine = TRUE
         LEFT JOIN LATERAL (
           SELECT views FROM post_stats_snapshots ps
            WHERE ps.post_id = p.id
            ORDER BY ps.captured_at DESC
            LIMIT 1
         ) s ON TRUE
        WHERE p.posted_at >= now() - ($1 || ' hours')::interval
          AND COALESCE(p.strategy_type, '') NOT IN ('network-digest', 'topic-digest', 'ad')
          AND COALESCE(p.title, '') <> ''
          ${channelFilter}
        ORDER BY p.posted_at DESC`,
      args,
    );
    return r.rows.map((row: any) => ({
      channelKey: row.channel_key,
      username:   row.username,
      messageId:  Number(row.message_id),
      title:      row.title,
      views:      row.views == null ? null : Number(row.views),
      postedAt:   new Date(row.posted_at),
      strategyType: row.strategy_type ?? null,
    }));
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
