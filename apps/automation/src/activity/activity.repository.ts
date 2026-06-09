import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

/** Normalized activity row as projected by the UNION query (snake_case, raw). */
export interface ActivityRow {
  source:      'strategy_run' | 'scheduled_post';
  row_id:      string;
  at:          Date;
  type:        'posted' | 'error' | 'skipped' | 'running';
  status:      string;
  channel_id:  string | null;
  channel:     string | null;
  strategy_id: string | null;
  strategy:    string | null;
  detail:      string | null;
  duration_ms: number | null;
}

export type ActivityType = ActivityRow['type'];

export interface ActivityListParams {
  type?:   ActivityType | null;
  limit:   number;
  offset:  number;
}

@Injectable()
export class ActivityRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Read-only activity feed unioning strategy executions and operator one-off
   * scheduled posts. Both sources project the same normalized columns; channel
   * labels resolve via LEFT JOIN so a deleted/private channel still renders.
   * Fetches `limit + 1` rows so the caller can compute `hasMore` without COUNT.
   */
  async list({ type, limit, offset }: ActivityListParams): Promise<ActivityRow[]> {
    const { rows } = await this.pool.query<ActivityRow>(
      `SELECT * FROM (
         SELECT
           'strategy_run'                                    AS source,
           sr.id::text                                       AS row_id,
           sr.started_at                                     AS at,
           CASE sr.status
             WHEN 'ok'      THEN 'posted'
             WHEN 'error'   THEN 'error'
             WHEN 'skipped' THEN 'skipped'
             ELSE 'running'
           END                                               AS type,
           sr.status                                         AS status,
           tc.id::text                                       AS channel_id,
           COALESCE(tc.channel_key, tc.username, tc.title)   AS channel,
           sb.id::text                                       AS strategy_id,
           sr.ext_id                                         AS strategy,
           sr.error                                          AS detail,
           sr.duration_ms                                    AS duration_ms
         FROM strategy_runs sr
         LEFT JOIN strategy_bindings sb ON sb.id = sr.strategy_id
         LEFT JOIN tracked_channels  tc ON tc.id = sb.channel_id

         UNION ALL

         SELECT
           'scheduled_post'                                  AS source,
           sp.id::text                                       AS row_id,
           sp.updated_at                                     AS at,
           CASE sp.status
             WHEN 'sent'     THEN 'posted'
             WHEN 'failed'   THEN 'error'
             WHEN 'canceled' THEN 'skipped'
             ELSE 'running'
           END                                               AS type,
           sp.status                                         AS status,
           tc.id::text                                       AS channel_id,
           COALESCE(tc.channel_key, tc.username, tc.title)   AS channel,
           NULL::text                                        AS strategy_id,
           'Scheduled post'                                  AS strategy,
           sp.error                                          AS detail,
           NULL::int                                         AS duration_ms
         FROM scheduled_publications sp
         LEFT JOIN tracked_channels tc ON tc.id = sp.channel_id
       ) ev
       WHERE ($1::text IS NULL OR ev.type = $1)
       ORDER BY ev.at DESC
       LIMIT $2 OFFSET $3`,
      [type ?? null, limit + 1, offset],
    );
    return rows;
  }
}
