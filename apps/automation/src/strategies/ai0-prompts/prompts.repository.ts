import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface PromptRow {
  id:             string; // image URL
  prompt_source:  string; // prompthero page URL
  category:       string;
  status:         string | null;
  posted:         string | null;
}

@Injectable()
export class PromptsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Get first unposted prompt for this category */
  async getNext(category: string): Promise<PromptRow | null> {
    const { rows } = await this.pool.query<PromptRow>(
      `SELECT id, prompt_source, category, status, posted
       FROM prompts
       WHERE category = $1
         AND provider = 'prompthero'
         AND status IS NULL
         AND NOT (posted ? 'TELEGRAM')
       LIMIT 1`,
      [category],
    );
    return rows[0] ?? null;
  }

  async countEligibleAll(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM prompts
       WHERE provider = 'prompthero'
         AND status IS NULL
         AND NOT (posted ? 'TELEGRAM')`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Mark prompt as posted to Telegram */
  async markPosted(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET posted = posted || jsonb_build_object('TELEGRAM', NOW()) WHERE id = $1`,
      [id],
    );
  }

  /** Mark prompt as error (skip on future runs) */
  async markError(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET status = 'ERROR' WHERE id = $1`,
      [id],
    );
  }
}
