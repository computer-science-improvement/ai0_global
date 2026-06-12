import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface CuratedPromptRow {
  id:          string;
  category:    string | null;
  title:       string | null;
  prompt_text: string;
  source:      string | null;
  media_url:   string;
  media_type:  string;   // 'image' | 'video'
}

export interface CuratedFilter {
  provider?:  string;
  mediaType?: string;
}

@Injectable()
export class CuratedPromptsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getNext(filter: CuratedFilter = {}, postedKey = 'TELEGRAM'): Promise<CuratedPromptRow | null> {
    const { rows } = await this.pool.query<CuratedPromptRow>(
      `SELECT id, category, title, prompt_text, source, media_url, media_type
       FROM prompts
       WHERE provider <> 'prompthero'
         AND prompt_text IS NOT NULL
         AND NOT (posted ? $3)
         AND status IS DISTINCT FROM 'ERROR'
         AND ($1::text IS NULL OR provider   = $1)
         AND ($2::text IS NULL OR media_type = $2)
       ORDER BY created_at
       LIMIT 1`,
      [filter.provider ?? null, filter.mediaType ?? null, postedKey],
    );
    return rows[0] ?? null;
  }

  async countEligible(filter: CuratedFilter = {}): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM prompts
       WHERE provider <> 'prompthero'
         AND prompt_text IS NOT NULL
         AND NOT (posted ? 'TELEGRAM')
         AND status IS DISTINCT FROM 'ERROR'
         AND ($1::text IS NULL OR provider   = $1)
         AND ($2::text IS NULL OR media_type = $2)`,
      [filter.provider ?? null, filter.mediaType ?? null],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async markPosted(id: string, postedKey = 'TELEGRAM'): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET posted = posted || jsonb_build_object($2::text, NOW()) WHERE id = $1`,
      [id, postedKey],
    );
  }

  async markError(id: string): Promise<void> {
    await this.pool.query(`UPDATE prompts SET status = 'ERROR' WHERE id = $1`, [id]);
  }
}
