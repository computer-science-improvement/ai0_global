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

  async finishOk(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE strategy_runs
         SET finished_at = now(),
             status      = 'ok',
             duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
       WHERE id = $1`,
      [runId],
    );
  }

  async finishError(runId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE strategy_runs
         SET finished_at = now(),
             status      = 'error',
             error       = $2,
             duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
       WHERE id = $1`,
      [runId, error.slice(0, 1000)],
    );
  }

  /**
   * Transition an in-flight run to 'skipped'. Distinct from a new
   * 'skipped' insert (recordSkipped) which is used when the strategy
   * was guarded out by the inFlight check before start() ran.
   */
  async finishSkipped(runId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE strategy_runs
         SET finished_at = now(),
             status      = 'skipped',
             error       = $2,
             duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
       WHERE id = $1`,
      [runId, reason.slice(0, 1000)],
    );
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
}
