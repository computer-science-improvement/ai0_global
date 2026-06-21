import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { MonitoredChatRow } from './agent.types';

@Injectable()
export class AgentMonitoredChatsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
  async upsert(chatId: string, title: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_monitored_chats (chat_id, title) VALUES ($1,$2)
       ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, updated_at = now()`, [chatId, title]);
  }
  async list(): Promise<MonitoredChatRow[]> {
    const { rows } = await this.pool.query<MonitoredChatRow>(`SELECT * FROM agent_monitored_chats ORDER BY title`);
    return rows;
  }
  async enabled(): Promise<MonitoredChatRow[]> {
    const { rows } = await this.pool.query<MonitoredChatRow>(`SELECT * FROM agent_monitored_chats WHERE enabled ORDER BY title`);
    return rows;
  }
  async setEnabled(chatId: string, enabled: boolean): Promise<void> {
    await this.pool.query(`UPDATE agent_monitored_chats SET enabled = $2, updated_at = now() WHERE chat_id = $1`, [chatId, enabled]);
  }
  async lastMessageId(chatId: string): Promise<number> {
    const { rows } = await this.pool.query<{ last_message_id: string }>(`SELECT last_message_id FROM agent_monitored_chats WHERE chat_id = $1`, [chatId]);
    return rows[0] ? Number(rows[0].last_message_id) : 0;
  }
  async setLastMessageId(chatId: string, id: number): Promise<void> {
    await this.pool.query(`UPDATE agent_monitored_chats SET last_message_id = $2, last_polled_at = now(), updated_at = now() WHERE chat_id = $1`, [chatId, id]);
  }
  async countEnabled(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM agent_monitored_chats WHERE enabled`);
    return Number(rows[0]?.n ?? 0);
  }
}
