import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { Opportunity, OpportunityKind, OpportunityRow } from './agent.types';

@Injectable()
export class AgentOpportunitiesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
  async upsert(msg: { chatId: string; chatTitle: string | null; messageId: number; text: string }, o: Opportunity): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_opportunities (chat_id, chat_title, message_id, message_text, kind, summary, score, suggested_action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chat_id, message_id) DO NOTHING`,
      [msg.chatId, msg.chatTitle, msg.messageId, msg.text, o.kind, o.summary, o.score, o.suggestedAction]);
  }
  async list(filter: { status?: string; kind?: OpportunityKind } = {}): Promise<OpportunityRow[]> {
    const where: string[] = []; const params: any[] = [];
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
    if (filter.kind)   { params.push(filter.kind);   where.push(`kind = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.pool.query<OpportunityRow>(
      `SELECT * FROM agent_opportunities ${clause} ORDER BY (status='new') DESC, score DESC, created_at DESC`, params);
    return rows;
  }
  async setStatus(id: string, status: 'new' | 'reviewed' | 'archived'): Promise<void> {
    await this.pool.query(`UPDATE agent_opportunities SET status = $2 WHERE id = $1`, [id, status]);
  }
}
