import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

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
       ORDER BY created_at ASC
       LIMIT 1`,
      [dataSource, channelId],
    );
    return rows[0] ?? null;
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
