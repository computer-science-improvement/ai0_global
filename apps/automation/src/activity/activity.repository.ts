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
  platform:    string;
  channel_id:  string | null;
  channel:     string | null;
  strategy_id: string | null;
  strategy:    string | null;
  detail:      string | null;
  duration_ms: number | null;
}

export type ActivityType = ActivityRow['type'];

export interface ActivityFilter {
  /** Concrete binding platforms to include, e.g. ['telegram'] or ['instagram','facebook','threads']. */
  platforms: string[];
  type?:     ActivityType | null;
  /** Inclusive ISO lower/upper bound on the event time. */
  from?:     string | null;
  to?:       string | null;
  /** Filter to one strategy by its ext_id slug. */
  strategy?: string | null;
  /** Filter to one resolved channel/account UUID. */
  channelId?: string | null;
}

export interface ActivityListParams extends ActivityFilter {
  limit:   number;
  offset:  number;
}

@Injectable()
export class ActivityRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** The normalized event UNION (strategy runs + operator scheduled posts) —
   *  shared by list() and count(). */
  private static readonly EVENTS_SQL = `
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
           COALESCE(sb.platform, 'telegram')                 AS platform,
           tc.id::text                                       AS channel_id,
           COALESCE(tc.channel_key, tc.username, tc.title,
                    '@' || ma.username, ma.account_id,
                    '@' || tt.username, tt.open_id)           AS channel,
           sb.id::text                                       AS strategy_id,
           sr.ext_id                                         AS strategy,
           sr.error                                          AS detail,
           sr.duration_ms                                    AS duration_ms
         FROM strategy_runs sr
         LEFT JOIN strategy_bindings sb ON sb.id = sr.strategy_id
         LEFT JOIN tracked_channels  tc ON tc.id = sb.channel_id
         LEFT JOIN meta_accounts     ma ON ma.id = sb.meta_account_id
         LEFT JOIN tiktok_accounts   tt ON tt.id = sb.tiktok_account_id

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
           'telegram'                                        AS platform,
           tc.id::text                                       AS channel_id,
           COALESCE(tc.channel_key, tc.username, tc.title)   AS channel,
           NULL::text                                        AS strategy_id,
           'Scheduled post'                                  AS strategy,
           sp.error                                          AS detail,
           NULL::int                                         AS duration_ms
         FROM scheduled_publications sp
         LEFT JOIN tracked_channels tc ON tc.id = sp.channel_id`;

  /** Build the shared WHERE clause + positional params from a filter. */
  private buildWhere(f: ActivityFilter): { where: string; params: unknown[] } {
    const params: unknown[] = [];
    const cond: string[] = [];
    params.push(f.platforms);            cond.push(`ev.platform = ANY($${params.length}::text[])`);
    if (f.type)      { params.push(f.type);      cond.push(`ev.type = $${params.length}`); }
    if (f.from)      { params.push(f.from);      cond.push(`ev.at >= $${params.length}::timestamptz`); }
    if (f.to)        { params.push(f.to);        cond.push(`ev.at <= $${params.length}::timestamptz`); }
    if (f.strategy)  { params.push(f.strategy);  cond.push(`ev.strategy = $${params.length}`); }
    if (f.channelId) { params.push(f.channelId); cond.push(`ev.channel_id = $${params.length}`); }
    return { where: cond.join(' AND '), params };
  }

  /**
   * Read-only activity feed unioning strategy executions and operator one-off
   * scheduled posts. Channel labels resolve via LEFT JOIN so a deleted/private
   * channel still renders. Fetches `limit + 1` rows so the caller can compute
   * `hasMore` without a COUNT.
   */
  async list({ limit, offset, ...filter }: ActivityListParams): Promise<ActivityRow[]> {
    const { where, params } = this.buildWhere(filter);
    const { rows } = await this.pool.query<ActivityRow>(
      `SELECT * FROM (${ActivityRepository.EVENTS_SQL}) ev
       WHERE ${where}
       ORDER BY ev.at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit + 1, offset],
    );
    return rows;
  }

  /** Total events matching a filter — drives the page count. */
  async count(filter: ActivityFilter): Promise<number> {
    const { where, params } = this.buildWhere(filter);
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM (${ActivityRepository.EVENTS_SQL}) ev WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  }
}
