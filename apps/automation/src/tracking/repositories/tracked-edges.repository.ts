import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';

export interface AdEdgeUpsert {
  sourceChannelId: string;
  targetUsername:  string;
  targetKind:      'tg_channel' | 'tg_user' | 'tg_invite' | 'instagram' | 'web';
  targetChannelId?: string | null;
  seenAt:          Date;
}

export interface EdgeRow {
  source_channel_id: string;
  target_channel_id: string | null;
  target_username:   string;
  target_kind:       string;
  ad_post_count:     number;
  first_seen_at:     Date;
  last_seen_at:      Date;
}

@Injectable()
export class TrackedEdgesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Increment ad_post_count for the (source, target) pair; insert if new. */
  async upsertSeen(input: AdEdgeUpsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO tracked_ad_edges
         (source_channel_id, target_channel_id, target_username, target_kind,
          ad_post_count, first_seen_at, last_seen_at)
       VALUES ($1, $2, LOWER($3), $4, 1, $5, $5)
       ON CONFLICT (source_channel_id, target_username, target_kind)
       DO UPDATE SET
         ad_post_count    = tracked_ad_edges.ad_post_count + 1,
         target_channel_id = COALESCE(EXCLUDED.target_channel_id, tracked_ad_edges.target_channel_id),
         last_seen_at     = GREATEST(tracked_ad_edges.last_seen_at, EXCLUDED.last_seen_at)`,
      [
        input.sourceChannelId,
        input.targetChannelId ?? null,
        input.targetUsername,
        input.targetKind,
        input.seenAt,
      ],
    );
  }

  /** Backfill target_channel_id once a previously-unknown channel gets tracked. */
  async linkResolvedTarget(targetUsername: string, channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE tracked_ad_edges
       SET target_channel_id = $2
       WHERE LOWER(target_username) = LOWER($1) AND target_channel_id IS NULL`,
      [targetUsername, channelId],
    );
  }

  async graph(from: Date | null, to: Date | null, minWeight: number): Promise<EdgeRow[]> {
    const args: unknown[] = [minWeight];
    let where = `ad_post_count >= $1`;
    if (from) { args.push(from); where += ` AND last_seen_at >= $${args.length}`; }
    if (to)   { args.push(to);   where += ` AND first_seen_at <= $${args.length}`; }
    const r = await this.pool.query<EdgeRow>(
      `SELECT * FROM tracked_ad_edges WHERE ${where}`, args,
    );
    return r.rows;
  }
}
