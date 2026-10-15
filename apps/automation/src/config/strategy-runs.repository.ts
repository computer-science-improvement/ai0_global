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

/**
 * `strategy_runs` is history since spec 023 phase B (the strategy scheduler that wrote it is gone). What remains
 * are the reads of the dashboard (last run per binding, a run's trace on the Logs page); runs a previous process
 * left at 'running' are closed by the boot check (`legacy-bindings.check.ts`).
 */
@Injectable()
export class StrategyRunsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** The execution-trace steps[] for a run (lazy-loaded when a log row expands). */
  async stepsFor(runId: string): Promise<unknown[]> {
    const { rows } = await this.pool.query<{ steps: unknown[] }>(
      `SELECT steps FROM strategy_runs WHERE id = $1`, [runId],
    );
    return rows[0]?.steps ?? [];
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
