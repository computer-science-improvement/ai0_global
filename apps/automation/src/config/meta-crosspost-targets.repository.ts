// apps/automation/src/config/meta-crosspost-targets.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { MetaPlatform } from './meta-accounts.repository';

export type CrosspostMode = 'mirror' | 'teaser';

export interface MetaCrosspostTargetRow {
  id:              string;
  channel_id:      string;
  platform:        MetaPlatform;
  meta_account_id: string;
  mode:            CrosspostMode;
  enabled:         boolean;
  created_at:      Date;
}

/** A cross-post target joined with the resolved Meta account it publishes to. */
export interface ResolvedCrosspostTarget extends MetaCrosspostTargetRow {
  account_active:    boolean;
  account_token_env: string;
  account_target_id: string;
}

export interface MetaCrosspostInsertInput {
  channel_id:      string;
  platform:        MetaPlatform;
  meta_account_id: string;
  mode:            CrosspostMode;
}

@Injectable()
export class MetaCrosspostTargetsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async listByChannel(channelId: string): Promise<MetaCrosspostTargetRow[]> {
    const { rows } = await this.pool.query<MetaCrosspostTargetRow>(
      `SELECT * FROM meta_crosspost_targets WHERE channel_id = $1 ORDER BY created_at`,
      [channelId],
    );
    return rows;
  }

  /** Enabled targets for a channel, joined with their Meta account. */
  async listEnabledResolved(channelId: string): Promise<ResolvedCrosspostTarget[]> {
    const { rows } = await this.pool.query<ResolvedCrosspostTarget>(
      `SELECT t.*, a.active AS account_active, a.token_env AS account_token_env,
              a.target_id AS account_target_id
       FROM meta_crosspost_targets t
       JOIN meta_accounts a ON a.id = t.meta_account_id
       WHERE t.channel_id = $1 AND t.enabled = true
       ORDER BY t.created_at`,
      [channelId],
    );
    return rows;
  }

  /** Distinct configured platforms per channel id — for the strategies list icons. */
  async platformsByChannel(): Promise<Map<string, MetaPlatform[]>> {
    const { rows } = await this.pool.query<{ channel_id: string; platform: MetaPlatform }>(
      `SELECT DISTINCT channel_id, platform FROM meta_crosspost_targets`,
    );
    const m = new Map<string, MetaPlatform[]>();
    for (const r of rows) m.set(r.channel_id, [...(m.get(r.channel_id) ?? []), r.platform]);
    return m;
  }

  async findById(id: string): Promise<MetaCrosspostTargetRow | null> {
    const { rows } = await this.pool.query<MetaCrosspostTargetRow>(
      `SELECT * FROM meta_crosspost_targets WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async insert(input: MetaCrosspostInsertInput): Promise<MetaCrosspostTargetRow> {
    const { rows } = await this.pool.query<MetaCrosspostTargetRow>(
      `INSERT INTO meta_crosspost_targets (channel_id, platform, meta_account_id, mode)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.channel_id, input.platform, input.meta_account_id, input.mode],
    );
    return rows[0];
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query(`UPDATE meta_crosspost_targets SET enabled = $2 WHERE id = $1`, [id, enabled]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM meta_crosspost_targets WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
