import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AgentActionRow, AgentActionStatus, AgentActionType } from './agent.types';

@Injectable()
export class AgentActionsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(input: { type: AgentActionType; threadId?: string | null; payload: Record<string, any> }): Promise<AgentActionRow> {
    const { rows } = await this.pool.query<AgentActionRow>(
      `INSERT INTO agent_actions (type, thread_id, payload)
       VALUES ($1, $2, $3::jsonb) RETURNING *`,
      [input.type, input.threadId ?? null, JSON.stringify(input.payload)],
    );
    return rows[0];
  }

  async list(status?: AgentActionStatus): Promise<AgentActionRow[]> {
    if (status) {
      const { rows } = await this.pool.query<AgentActionRow>(
        `SELECT * FROM agent_actions WHERE status = $1 ORDER BY created_at DESC`, [status]);
      return rows;
    }
    const { rows } = await this.pool.query<AgentActionRow>(
      `SELECT * FROM agent_actions ORDER BY created_at DESC`);
    return rows;
  }

  async findById(id: string): Promise<AgentActionRow | null> {
    const { rows } = await this.pool.query<AgentActionRow>(`SELECT * FROM agent_actions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async setStatus(id: string, status: AgentActionStatus, patch: { executedAt?: boolean; error?: string } = {}): Promise<void> {
    const execClause = patch.executedAt ? `, executed_at = now()` : '';
    await this.pool.query(
      `UPDATE agent_actions SET status = $2, error = $3${execClause}, updated_at = now() WHERE id = $1`,
      [id, status, patch.error ?? null],
    );
  }

  /** Merge keys into the JSONB payload (e.g. record the scheduled_post id). */
  async mergePayload(id: string, extra: Record<string, any>): Promise<void> {
    await this.pool.query(
      `UPDATE agent_actions SET payload = payload || $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(extra)],
    );
  }

  async countRepliesSince(hours: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM agent_actions
       WHERE type = 'reply' AND status = 'done' AND executed_at > now() - ($1 * interval '1 hour')`,
      [hours],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
