// apps/automation/src/discovery/repositories/channel-themes.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

@Injectable()
export class ChannelThemesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Returns null when the channel doesn't exist. */
  async getThemes(channelId: string): Promise<string[] | null> {
    const { rows } = await this.pool.query<{ themes: string[] }>(
      `SELECT themes FROM tracked_channels WHERE id = $1`,
      [channelId],
    );
    return rows[0]?.themes ?? null;
  }

  /** Returns false when the channel doesn't exist. Deduplicates the input array. */
  async setThemes(channelId: string, themes: string[]): Promise<boolean> {
    const dedup = Array.from(new Set(themes));
    const { rowCount } = await this.pool.query(
      `UPDATE tracked_channels SET themes = $1::text[] WHERE id = $2`,
      [dedup, channelId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * List usernames of channels the operator owns. Used by RecommendationsService
   * to exclude them from the candidate pool.
   */
  async listMyUsernames(): Promise<string[]> {
    const { rows } = await this.pool.query<{ username: string }>(
      `SELECT username FROM tracked_channels
       WHERE is_mine = true AND username IS NOT NULL`,
    );
    return rows.map(r => r.username);
  }
}
