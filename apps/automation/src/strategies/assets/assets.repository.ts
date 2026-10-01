import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { MARK_ERROR_SET, postedErrorKey } from '../../common/dedup/posted-error';

export interface AssetRow {
  id:          string;
  data_source: string;
  title:       string;
  description: string;
  link:        string | null;
  source_url:  string | null;
  category:    string | null;
  extra:       Record<string, unknown> | null;
}

@Injectable()
export class AssetsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Get next unposted asset for the given data_source and channel */
  async getNext(dataSource: string, channelId: string): Promise<AssetRow | null> {
    const { rows } = await this.pool.query<AssetRow>(
      `SELECT id, data_source, title, description, link, source_url, category, extra
       FROM assets
       WHERE data_source = $1
         AND NOT (posted ? $2)
         AND NOT (posted ? $3)
       ORDER BY created_at ASC
       LIMIT 1`,
      [dataSource, channelId, postedErrorKey(channelId)],
    );
    return rows[0] ?? null;
  }

  async countEligible(dataSource: string, channelId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM assets
       WHERE data_source = $1 AND NOT (posted ? $2) AND NOT (posted ? $3)`,
      [dataSource, channelId, postedErrorKey(channelId)],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Mark an asset unpublishable for this channel (posted["error:<channel>"]). */
  async markError(id: string, channelId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE assets SET ${MARK_ERROR_SET} WHERE id = $1`,
      [id, postedErrorKey(channelId), reason],
    );
  }

  /** Mark asset as posted for this channel */
  async markPosted(id: string, channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE assets
       SET posted = posted || jsonb_build_object($2::text, NOW()::text)
       WHERE id = $1`,
      [id, channelId],
    );
  }
}
