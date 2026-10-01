import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { MARK_ERROR_SET, postedErrorKey } from '../../common/dedup/posted-error';

export interface BirthdayRow {
  id:    string;
  month: number;
  day:   number;
  year:  number | null;
  name:  string;
}

@Injectable()
export class MotivationBiographyRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getToday(channelId: string): Promise<BirthdayRow | null> {
    const { rows } = await this.pool.query<BirthdayRow>(
      `SELECT id, month, day, year, name
       FROM birthdays
       WHERE month = EXTRACT(month FROM CURRENT_DATE)
         AND day   = EXTRACT(day   FROM CURRENT_DATE)
         AND NOT (posted ? $1)
         AND NOT (posted ? $2)
       ORDER BY year ASC
       LIMIT 1`,
      [channelId, postedErrorKey(channelId)],
    );
    return rows[0] ?? null;
  }

  /**
   * Total runway: ALL birthdays not yet posted to this channel. Unlike
   * getToday() this omits the today-only month/day filter — the low-content
   * warning must reflect real remaining supply, not the 0–1 eligible today.
   */
  async countEligible(channelId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM birthdays WHERE NOT (posted ? $1) AND NOT (posted ? $2)`,
      [channelId, postedErrorKey(channelId)],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Mark a person unpublishable for this channel (posted["error:<channel>"]). */
  async markError(id: string, channelId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE birthdays SET ${MARK_ERROR_SET} WHERE id = $1`,
      [id, postedErrorKey(channelId), reason],
    );
  }

  async markPosted(id: string, channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE birthdays SET posted = posted || jsonb_build_object($2::text, NOW()) WHERE id = $1`,
      [id, channelId],
    );
  }
}
