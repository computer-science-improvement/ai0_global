// apps/automation/src/config/youtube-landing.repository.ts
// Spec 026 FR-010: the landing columns of youtube_accounts (migration 066). Only
// public projection columns are selected here — never the token columns.
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface YoutubeLandingRow {
  id:              string;
  channel_id:      string;
  title:           string | null;
  handle:          string | null;
  subscribers:     number | null;
  landing_visible: boolean;
  landing_order:   number;
}

const COLUMNS = `id, channel_id, title, handle, subscribers, landing_visible, landing_order`;

@Injectable()
export class YoutubeLandingRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  /** Public landing: active AND featured channels only. */
  async listFeatured(): Promise<YoutubeLandingRow[]> {
    const { rows } = await this.pool.query<YoutubeLandingRow>(
      `SELECT ${COLUMNS} FROM youtube_accounts WHERE landing_visible AND active ORDER BY landing_order, created_at`);
    return rows;
  }

  /** Admin: every active channel (featured or not); inactive ones are hidden (BR-MKT-01). */
  async listCandidates(): Promise<YoutubeLandingRow[]> {
    const { rows } = await this.pool.query<YoutubeLandingRow>(
      `SELECT ${COLUMNS} FROM youtube_accounts WHERE active ORDER BY landing_order, created_at`);
    return rows;
  }

  async setLanding(id: string, opts: { visible: boolean; order: number }): Promise<void> {
    await this.pool.query(
      `UPDATE youtube_accounts SET landing_visible = $2, landing_order = $3 WHERE id = $1`,
      [id, opts.visible, opts.order]);
  }
}
