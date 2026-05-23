// apps/automation/src/config/strategy-bindings.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface StrategyBindingRow {
  id:          string;
  ext_id:      string;
  type:        string;
  channel_id:  string;
  schedule:    string;
  params:      Record<string, unknown>;
  enabled:     boolean;
  notes:       string | null;
}

export interface StrategyBindingInsertInput {
  ext_id:     string;
  type:       string;
  channel_id: string;
  schedule:   string;
  params:     Record<string, unknown>;
  enabled?:   boolean;
}

@Injectable()
export class StrategyBindingsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<StrategyBindingRow[]> {
    const { rows } = await this.pool.query<StrategyBindingRow>(
      `SELECT id, ext_id, type, channel_id, schedule, params, enabled, notes
       FROM strategy_bindings
       ORDER BY ext_id`,
    );
    return rows;
  }

  async insertIfMissing(input: StrategyBindingInsertInput): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, true))
       ON CONFLICT (ext_id) DO NOTHING`,
      [
        input.ext_id, input.type, input.channel_id, input.schedule,
        JSON.stringify(input.params), input.enabled ?? true,
      ],
    );
    return (rowCount ?? 0) > 0;
  }
}
