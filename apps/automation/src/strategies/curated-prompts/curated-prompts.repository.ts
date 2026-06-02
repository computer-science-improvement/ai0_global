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

  async getNext(filter: CuratedFilter = {}): Promise<CuratedPromptRow | null> {
    const { rows } = await this.pool.query<CuratedPromptRow>(
      `SELECT id, category, title, prompt_text, source, media_url, media_type
       FROM prompts
       WHERE provider <> 'prompthero'
         AND prompt_text IS NOT NULL
         AND NOT (posted ? 'TELEGRAM')
         AND status IS DISTINCT FROM 'ERROR'
         AND ($1::text IS NULL OR provider   = $1)
         AND ($2::text IS NULL OR media_type = $2)
       ORDER BY created_at
       LIMIT 1`,
      [filter.provider ?? null, filter.mediaType ?? null],
    );
    return rows[0] ?? null;
  }

  async markPosted(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET posted = posted || jsonb_build_object('TELEGRAM', NOW()) WHERE id = $1`,
      [id],
    );
  }

  async markError(id: string): Promise<void> {
    await this.pool.query(`UPDATE prompts SET status = 'ERROR' WHERE id = $1`, [id]);
  }
}
