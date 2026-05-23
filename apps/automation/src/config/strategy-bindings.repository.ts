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

  async findById(id: string): Promise<StrategyBindingRow | null> {
    const { rows } = await this.pool.query<StrategyBindingRow>(
      `SELECT id, ext_id, type, channel_id, schedule, params, enabled, notes
       FROM strategy_bindings WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async findByExtId(extId: string): Promise<StrategyBindingRow | null> {
    const { rows } = await this.pool.query<StrategyBindingRow>(
      `SELECT id, ext_id, type, channel_id, schedule, params, enabled, notes
       FROM strategy_bindings WHERE ext_id = $1`, [extId],
    );
    return rows[0] ?? null;
  }

  async insert(input: StrategyBindingInsertInput): Promise<StrategyBindingRow> {
    const { rows } = await this.pool.query<StrategyBindingRow>(
      `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, true))
       RETURNING id, ext_id, type, channel_id, schedule, params, enabled, notes`,
      [
        input.ext_id, input.type, input.channel_id, input.schedule,
        JSON.stringify(input.params), input.enabled ?? true,
      ],
    );
    return rows[0];
  }

  /**
   * Patch any subset of fields. `params` is a full replacement when provided.
   * Returns the updated row or null if no row was found.
   */
  async update(id: string, patch: {
    type?:       string;
    channel_id?: string;
    schedule?:   string;
    params?:     Record<string, unknown>;
    enabled?:    boolean;
    notes?:      string | null;
  }): Promise<StrategyBindingRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let i = 2;
    if (patch.type        !== undefined) { sets.push(`type = $${i++}`);        params.push(patch.type); }
    if (patch.channel_id  !== undefined) { sets.push(`channel_id = $${i++}`);  params.push(patch.channel_id); }
    if (patch.schedule    !== undefined) { sets.push(`schedule = $${i++}`);    params.push(patch.schedule); }
    if (patch.params      !== undefined) { sets.push(`params = $${i++}::jsonb`); params.push(JSON.stringify(patch.params)); }
    if (patch.enabled     !== undefined) { sets.push(`enabled = $${i++}`);     params.push(patch.enabled); }
    if (patch.notes       !== undefined) { sets.push(`notes = $${i++}`);       params.push(patch.notes); }
    if (sets.length === 0) return this.findById(id);
    const { rows } = await this.pool.query<StrategyBindingRow>(
      `UPDATE strategy_bindings SET ${sets.join(', ')}
       WHERE id = $1
       RETURNING id, ext_id, type, channel_id, schedule, params, enabled, notes`,
      params,
    );
    return rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM strategy_bindings WHERE id = $1`, [id],
    );
    return (rowCount ?? 0) > 0;
  }
}
