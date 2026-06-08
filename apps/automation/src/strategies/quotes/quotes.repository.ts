import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface QuoteRow {
  id:       string;
  text:     string;
  author:   string | null;
  category: string | null;
  url:      string | null;
}

@Injectable()
export class QuotesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Get a random unposted quote, optionally filtered by category */
  async getRandom(channelId: string, category?: string): Promise<QuoteRow | null> {
    const conditions = [`NOT (posted ? $1)`];
    const params: unknown[] = [channelId];

    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    const { rows } = await this.pool.query<QuoteRow>(
      `SELECT id, text, author, category, url
       FROM quotes
       WHERE ${conditions.join(' AND ')}
       ORDER BY random()
       LIMIT 1`,
      params,
    );
    return rows[0] ?? null;
  }

  async countEligible(channelId: string, category?: string): Promise<number> {
    const conditions = ['NOT (posted ? $1)'];
    const params: unknown[] = [channelId];
    if (category) { conditions.push(`category = $${params.length + 1}`); params.push(category); }
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM quotes WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Check if this author has a birthday today */
  async isBirthdayToday(author: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM birthdays
         WHERE month = EXTRACT(month FROM CURRENT_DATE)
           AND day   = EXTRACT(day   FROM CURRENT_DATE)
           AND name ILIKE $1
       ) AS found`,
      [`%${author}%`],
    );
    return rows[0]?.found ?? false;
  }

  /** Mark quote as posted for this channel */
  async markPosted(id: string, channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE quotes SET posted = posted || jsonb_build_object($2::text, NOW()) WHERE id = $1`,
      [id, channelId],
    );
  }
}
