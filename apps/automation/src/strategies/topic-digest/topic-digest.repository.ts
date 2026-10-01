// Read-only query for the topic-digest strategy: our own already-published
// posts of the chosen source strategies (e.g. ai0-news + ua-news) in the
// window. Deliberately a RECAP of own content (retention loop, no dedup
// interaction with the single-post strategies), not a second RSS ingestion.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import type { DigestPostRow } from '../network-digest/network-digest.repository';

@Injectable()
export class TopicDigestRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async postsInWindow(
    windowHours: number,
    strategyTypes: string[],
    sourceChannels?: string[],
  ): Promise<DigestPostRow[]> {
    const args: unknown[] = [windowHours, strategyTypes];
    let channelFilter = '';
    if (sourceChannels && sourceChannels.length > 0) {
      args.push(sourceChannels);
      channelFilter = `AND p.channel_id = ANY($${args.length})`;
    }
    const r = await this.pool.query(
      `SELECT p.channel_id          AS channel_key,
              tc.username           AS username,
              p.message_id          AS message_id,
              COALESCE(p.title, '') AS title,
              NULL::int             AS views,
              p.posted_at           AS posted_at,
              p.strategy_type       AS strategy_type
         FROM published_posts p
         JOIN tracked_channels tc ON tc.channel_key = p.channel_id
        WHERE p.posted_at >= now() - ($1 || ' hours')::interval
          AND p.strategy_type = ANY($2)
          AND COALESCE(p.title, '') <> ''
          ${channelFilter}
        ORDER BY p.posted_at ASC`,
      args,
    );
    return r.rows.map((row: any) => ({
      channelKey: row.channel_key,
      username:   row.username,
      messageId:  Number(row.message_id),
      title:      row.title,
      views:      null,
      postedAt:   new Date(row.posted_at),
      strategyType: row.strategy_type ?? null,
    }));
  }
}
