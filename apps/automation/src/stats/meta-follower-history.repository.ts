// meta-follower-history.repository.ts — hourly follower snapshots per Meta account.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface FollowerPoint { at: Date; followers: number; }
export interface FollowerDelta { followers: number | null; delta24h: number | null; delta7d: number | null; }

@Injectable()
export class MetaFollowerHistoryRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async insert(accountId: string, followers: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO meta_follower_history (account_id, followers)
       VALUES ($1::uuid, $2::int)
       ON CONFLICT DO NOTHING`,
      [accountId, followers],
    );
  }

  async history(accountId: string, from?: Date, to?: Date): Promise<FollowerPoint[]> {
    const { rows } = await this.pool.query<FollowerPoint>(
      `SELECT snapshot_at AS at, followers
         FROM meta_follower_history
        WHERE account_id = $1::uuid
          AND ($2::timestamptz IS NULL OR snapshot_at >= $2)
          AND ($3::timestamptz IS NULL OR snapshot_at <= $3)
        ORDER BY snapshot_at ASC`,
      [accountId, from ?? null, to ?? null],
    );
    return rows.map(r => ({ at: r.at, followers: r.followers }));
  }

  /**
   * Current followers + short-term deltas. Each baseline is the nearest snapshot
   * at-or-before the cutoff (24h / 7d ago). On a collection gap the baseline may
   * be somewhat older than the nominal window, so the delta is an approximation —
   * acceptable for the dashboard's convenience figures (the chart series itself is
   * always exact). Returning baseline timestamps for strict windowing is a future
   * refinement, deferred for Phase A.
   */
  async latestWithDelta(accountId: string): Promise<FollowerDelta> {
    const { rows } = await this.pool.query(
      `WITH latest AS (
         SELECT followers FROM meta_follower_history
          WHERE account_id = $1::uuid ORDER BY snapshot_at DESC LIMIT 1),
       d1 AS (
         SELECT followers FROM meta_follower_history
          WHERE account_id = $1::uuid AND snapshot_at <= now() - interval '24 hours'
          ORDER BY snapshot_at DESC LIMIT 1),
       d7 AS (
         SELECT followers FROM meta_follower_history
          WHERE account_id = $1::uuid AND snapshot_at <= now() - interval '7 days'
          ORDER BY snapshot_at DESC LIMIT 1)
       SELECT (SELECT followers FROM latest)                              AS followers,
              (SELECT followers FROM latest) - (SELECT followers FROM d1) AS delta24h,
              (SELECT followers FROM latest) - (SELECT followers FROM d7) AS delta7d`,
      [accountId],
    );
    const r = rows[0] ?? {};
    return {
      followers: r.followers ?? null,
      delta24h:  r.delta24h ?? null,
      delta7d:   r.delta7d ?? null,
    };
  }

  /**
   * One-shot 24h follower delta for EVERY account (avoids N+1 on the accounts
   * list). delta = latest followers − the nearest snapshot at-or-before 24h ago;
   * null when there's no baseline that old yet.
   */
  async delta24hByAccount(): Promise<Map<string, number | null>> {
    const { rows } = await this.pool.query<{ account_id: string; delta24h: number | null }>(
      `WITH latest AS (
         SELECT DISTINCT ON (account_id) account_id, followers
           FROM meta_follower_history ORDER BY account_id, snapshot_at DESC),
       d1 AS (
         SELECT DISTINCT ON (account_id) account_id, followers
           FROM meta_follower_history
          WHERE snapshot_at <= now() - interval '24 hours'
          ORDER BY account_id, snapshot_at DESC)
       SELECT l.account_id,
              l.followers - d.followers AS delta24h
         FROM latest l
         LEFT JOIN d1 d ON d.account_id = l.account_id`,
    );
    const m = new Map<string, number | null>();
    for (const r of rows) m.set(r.account_id, r.delta24h ?? null);
    return m;
  }
}
