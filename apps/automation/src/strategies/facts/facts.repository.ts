import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface FactRow {
  id:            string;
  article_slug:  string;
  article_title: string;
  article_url:   string | null;
  image_url:     string | null;
  content:       string;
  category:      string | null;
}

@Injectable()
export class FactsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Get a random unposted fact for this channel */
  async getRandom(channelId: string): Promise<FactRow | null> {
    const { rows } = await this.pool.query<FactRow>(
      `SELECT id, article_slug, article_title, article_url, image_url, content, category
       FROM facts
       WHERE NOT (posted ? $1)
       ORDER BY random()
       LIMIT 1`,
      [channelId],
    );
    return rows[0] ?? null;
  }

  /** Mark fact as posted for this channel */
  async markPosted(id: string, channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE facts SET posted = posted || jsonb_build_object($2, NOW()) WHERE id = $1`,
      [id, channelId],
    );
  }
}
