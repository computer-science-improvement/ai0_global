import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';

export interface StrategyBindingRow {
  id:         string;
  extId:      string;
  type:       string;
  channelId:  string;
  schedule:   string;
  params:     Record<string, unknown>;
  enabled:    boolean;
  notes:      string | null;
  createdAt:  Date;
}

export interface StrategyBindingInsertInput {
  extId:     string;
  type:      string;
  channelId: string;
  schedule:  string;
  params?:   Record<string, unknown>;
  enabled?:  boolean;
  notes?:    string | null;
}

@Injectable()
export class StrategyBindingsRepository {
  private readonly logger = new Logger(StrategyBindingsRepository.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<StrategyBindingRow[]> {
    const r = await this.pool.query<any>(
      `SELECT * FROM strategy_bindings ORDER BY created_at ASC`,
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  async insertIfMissing(input: StrategyBindingInsertInput): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO strategy_bindings
         (ext_id, type, channel_id, schedule, params, enabled, notes)
       VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb),
               COALESCE($6, true), $7)
       ON CONFLICT (ext_id) DO NOTHING
       RETURNING id`,
      [
        input.extId,
        input.type,
        input.channelId,
        input.schedule,
        input.params ? JSON.stringify(input.params) : null,
        input.enabled ?? null,
        input.notes ?? null,
      ],
    );
    return r.rows[0]?.id ?? null;
  }

  private toEntity(r: any): StrategyBindingRow {
    return {
      id:         r.id,
      extId:      r.ext_id,
      type:       r.type,
      channelId:  r.channel_id,
      schedule:   r.schedule,
      params:     r.params ?? {},
      enabled:    r.enabled,
      notes:      r.notes,
      createdAt:  r.created_at,
    };
  }
}
