// apps/automation/src/config/strategy-runs.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface StrategyRunRow {
  id:           string;
  strategy_id:  string;
  ext_id:       string;
  started_at:   Date;
  finished_at:  Date | null;
  status:       'running' | 'ok' | 'error' | 'skipped';
  error:        string | null;
  duration_ms:  number | null;
}

@Injectable()
export class StrategyRunsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Mark a strategy run as started. Returns the new row id, which the caller
   * passes back to `finish()` once the run completes. Status starts as
   * `running`; the upserts in finish/skip flip it terminal.
   */
  async start(strategyId: string, extId: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO strategy_runs (strategy_id, ext_id, status)
       VALUES ($1, $2, 'running')
       RETURNING id`,
      [strategyId, extId],
    );
    return rows[0].id;
  }

  async finishOk(runId: string, steps?: unknown[]): Promise<void> {
    await this.pool.query(
      `UPDATE strategy_runs
         SET finished_at = now(),
             status      = 'ok',
             steps       = COALESCE($2::jsonb, steps),
             duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
       WHERE id = $1`,
      [runId, steps ? JSON.stringify(steps) : null],
    );
  }

  async finishError(runId: string, error: string, steps?: unknown[]): Promise<void> {
    await this.pool.query(
      `UPDATE strategy_runs
         SET finished_at = now(),
             status      = 'error',
             error       = $2,
             steps       = COALESCE($3::jsonb, steps),
             duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
       WHERE id = $1`,
      [runId, error.slice(0, 1000), steps ? JSON.stringify(steps) : null],
    );
  }

  /**
   * Transition an in-flight run to 'skipped'. Distinct from a new
   * 'skipped' insert (recordSkipped) which is used when the strategy
   * was guarded out by the inFlight check before start() ran.
   */
  async finishSkipped(runId: string, reason: string, steps?: unknown[]): Promise<void> {
    await this.pool.query(
      `UPDATE strategy_runs
         SET finished_at = now(),
             status      = 'skipped',
             error       = $2,
             steps       = COALESCE($3::jsonb, steps),
             duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
       WHERE id = $1`,
      [runId, reason.slice(0, 1000), steps ? JSON.stringify(steps) : null],
    );
  }

  /** The execution-trace steps[] for a run (lazy-loaded when a log row expands). */
  async stepsFor(runId: string): Promise<unknown[]> {
    const { rows } = await this.pool.query<{ steps: unknown[] }>(
      `SELECT steps FROM strategy_runs WHERE id = $1`, [runId],
    );
    return rows[0]?.steps ?? [];
  }

  /**
   * Reconcile rows orphaned by a hard stop: any run still 'running' at boot
   * belongs to a previous process that died mid-run (a graceful run always
   * flips terminal). The scheduler hasn't started ticking yet, so nothing is
   * legitimately in-flight here — flip them to 'error' so the activity log
   * stops showing a phantom spinner. Returns how many were reconciled.
   */
  async failOrphanedRunning(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE strategy_runs
         SET finished_at = now(),
             status      = 'error',
             error       = 'interrupted: service restarted mid-run',
             duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
       WHERE status = 'running'`,
    );
    return rowCount ?? 0;
  }

  /** Record a tick that was skipped because the previous one was still running. */
  async recordSkipped(strategyId: string, extId: string, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO strategy_runs (strategy_id, ext_id, status, finished_at, error)
       VALUES ($1, $2, 'skipped', now(), $3)`,
      [strategyId, extId, reason.slice(0, 1000)],
    );
  }

  /** Most-recent N runs for a given strategy. */
  async recent(strategyId: string, limit = 20): Promise<StrategyRunRow[]> {
    const { rows } = await this.pool.query<StrategyRunRow>(
      `SELECT id, strategy_id, ext_id, started_at, finished_at, status, error, duration_ms
       FROM strategy_runs
       WHERE strategy_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [strategyId, limit],
    );
    return rows;
  }

  /** Latest run per strategy — used by the list endpoint for inline "last run" cells. */
  async latestPerStrategy(): Promise<Map<string, StrategyRunRow>> {
    const { rows } = await this.pool.query<StrategyRunRow>(
      `SELECT DISTINCT ON (strategy_id)
              id, strategy_id, ext_id, started_at, finished_at, status, error, duration_ms
       FROM strategy_runs
       ORDER BY strategy_id, started_at DESC`,
    );
    const m = new Map<string, StrategyRunRow>();
    for (const r of rows) m.set(r.strategy_id, r);
    return m;
  }

  /**
   * Strategies whose most-recent runs are a streak of `>= threshold` errors
   * (i.e. every error since the last ok/skipped). Used by the alerting watcher
   * to ping the owner about a strategy that keeps failing.
   */
  async consecutiveErrorStrategies(
    threshold: number,
  ): Promise<Array<{ ext_id: string; consecutive_errors: number; last_error: string | null; last_at: Date }>> {
    const { rows } = await this.pool.query(
      `WITH last_ok AS (
         SELECT ext_id, max(started_at) AS ts
         FROM strategy_runs
         WHERE status IN ('ok','skipped')
         GROUP BY ext_id
       )
       SELECT r.ext_id,
              count(*)::int                                        AS consecutive_errors,
              (array_agg(r.error ORDER BY r.started_at DESC))[1]   AS last_error,
              max(r.started_at)                                    AS last_at
       FROM strategy_runs r
       LEFT JOIN last_ok l ON l.ext_id = r.ext_id
       WHERE r.status = 'error'
         AND (l.ts IS NULL OR r.started_at > l.ts)
       GROUP BY r.ext_id
       HAVING count(*) >= $1
       ORDER BY consecutive_errors DESC`,
      [threshold],
    );
    return rows as any;
  }

  /**
   * Runs still marked 'running' for longer than `minutes` — a dead leftover (a
   * crash mid-run, or a timeout/guard that didn't fire). Surfaced by the alerting
   * watcher so a stuck queue is noticed without opening the dashboard.
   */
  async stuckRunning(minutes: number): Promise<Array<{ ext_id: string; started_at: Date }>> {
    const { rows } = await this.pool.query(
      `SELECT ext_id, started_at
       FROM strategy_runs
       WHERE status = 'running'
         AND started_at < now() - ($1 * interval '1 minute')
       ORDER BY started_at ASC`,
      [minutes],
    );
    return rows as any;
  }
}
