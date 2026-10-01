import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { MARK_ERROR_SET, postedErrorKey } from '../../common/dedup/posted-error';

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

  /** First unposted, non-errored prompt for this category (oldest first —
   *  deterministic, so a poisoned row can't randomly shadow the rest). */
  async getNext(category: string, postedKey = 'TELEGRAM'): Promise<PromptRow | null> {
    const { rows } = await this.pool.query<PromptRow>(
      `SELECT id, prompt_source, category, status, posted
       FROM prompts
       WHERE category = $1
         AND provider = 'prompthero'
         AND status IS NULL
         AND NOT (posted ? $2)
         AND NOT (posted ? $3)
       ORDER BY created_at, id
       LIMIT 1`,
      [category, postedKey, postedErrorKey(postedKey)],
    );
    return rows[0] ?? null;
  }

  async countEligibleAll(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM prompts
       WHERE provider = 'prompthero'
         AND status IS NULL
         AND NOT (posted ? 'TELEGRAM')
         AND NOT (posted ? 'error:TELEGRAM')`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Mark prompt as posted to the given destination */
  async markPosted(id: string, postedKey = 'TELEGRAM'): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET posted = posted || jsonb_build_object($2::text, NOW()) WHERE id = $1`,
      [id, postedKey],
    );
  }

  /**
   * Mark a prompt unpublishable for this destination (dead page/image, invalid
   * prompt, permanent publish error) — `posted["error:<key>"] = {at, reason}`,
   * excluded by getNext. Legacy rows with status = 'ERROR' stay excluded too.
   */
  async markError(id: string, postedKey: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET ${MARK_ERROR_SET} WHERE id = $1`,
      [id, postedErrorKey(postedKey), reason],
    );
  }
}
