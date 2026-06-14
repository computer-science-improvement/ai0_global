// meta-account-insights.repository.ts — daily account insights (reach/impressions/
// profile views) per Meta account. Mirrors MetaFollowerHistoryRepository.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { MetaInsightDay } from '../config/meta-insights';

@Injectable()
export class MetaAccountInsightsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsertDay(
    accountId: string,
    day: string,
    m: { reach: number | null; impressions: number | null; profileViews: number | null },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO meta_account_insights (account_id, day, reach, impressions, profile_views)
       VALUES ($1::uuid, $2::date, $3, $4, $5)
       ON CONFLICT (account_id, day) DO UPDATE
         SET reach = EXCLUDED.reach,
             impressions = EXCLUDED.impressions,
             profile_views = EXCLUDED.profile_views,
             captured_at = now()`,
      [accountId, day, m.reach, m.impressions, m.profileViews],
    );
  }

  async history(accountId: string, from?: Date, to?: Date): Promise<MetaInsightDay[]> {
    const { rows } = await this.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, reach, impressions, profile_views
         FROM meta_account_insights
        WHERE account_id = $1::uuid
          AND ($2::date IS NULL OR day >= $2)
          AND ($3::date IS NULL OR day <= $3)
        ORDER BY day ASC`,
      [accountId, from ?? null, to ?? null],
    );
    return rows.map((r: any) => ({
      day: r.day, reach: r.reach, impressions: r.impressions, profileViews: r.profile_views,
    }));
  }
}
