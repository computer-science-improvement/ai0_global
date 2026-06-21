import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AgentCategory, AgentThreadRow, RawDm, TriageResult } from './agent.types';

@Injectable()
export class AgentInboxRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsertThread(dm: RawDm, t: TriageResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_dm_threads
         (peer_id, peer_username, peer_name, last_message_id, last_message_at, last_text,
          category, summary, fields, draft_reply, score, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'new',now())
       ON CONFLICT (peer_id) DO UPDATE SET
         peer_username   = EXCLUDED.peer_username,
         peer_name       = EXCLUDED.peer_name,
         last_message_id = EXCLUDED.last_message_id,
         last_message_at = EXCLUDED.last_message_at,
         last_text       = EXCLUDED.last_text,
         category        = EXCLUDED.category,
         summary         = EXCLUDED.summary,
         fields          = EXCLUDED.fields,
         draft_reply     = EXCLUDED.draft_reply,
         score           = EXCLUDED.score,
         status          = 'new',
         updated_at      = now()`,
      [dm.peerId, dm.peerUsername, dm.peerName, dm.messageId, dm.date, dm.text,
       t.category, t.summary, JSON.stringify(t.fields), t.draftReply, t.score],
    );
  }

  async list(filter: { status?: string; category?: AgentCategory } = {}): Promise<AgentThreadRow[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.status)   { params.push(filter.status);   where.push(`status = $${params.length}`); }
    if (filter.category) { params.push(filter.category); where.push(`category = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.pool.query<AgentThreadRow>(
      `SELECT * FROM agent_dm_threads ${clause} ORDER BY (status='new') DESC, score DESC, last_message_at DESC`,
      params,
    );
    return rows;
  }

  async setStatus(id: string, status: 'new' | 'reviewed' | 'archived'): Promise<void> {
    await this.pool.query(`UPDATE agent_dm_threads SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  }

  /** Newest message id we've already triaged for this peer (0 if unseen). */
  async lastMessageIdFor(peerId: string): Promise<number> {
    const { rows } = await this.pool.query<{ last_message_id: string }>(
      `SELECT last_message_id FROM agent_dm_threads WHERE peer_id = $1`, [peerId],
    );
    return rows[0] ? Number(rows[0].last_message_id) : 0;
  }

  async touchCursor(sessionId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_poll_cursor (session_id, last_polled_at) VALUES ($1, now())
       ON CONFLICT (session_id) DO UPDATE SET last_polled_at = now()`,
      [sessionId],
    );
  }

  async lastPolledAt(sessionId: string): Promise<Date | null> {
    const { rows } = await this.pool.query<{ last_polled_at: Date | null }>(
      `SELECT last_polled_at FROM agent_poll_cursor WHERE session_id = $1`, [sessionId],
    );
    return rows[0]?.last_polled_at ?? null;
  }

  /** Return the peer contact info for a thread (used by AgentActionsService to send a reply). */
  async threadPeer(id: string): Promise<{ peer_id: string; peer_username: string | null } | null> {
    const { rows } = await this.pool.query<{ peer_id: string; peer_username: string | null }>(
      `SELECT peer_id, peer_username FROM agent_dm_threads WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  /** Record that a reply was sent: stamp replied_at, store sent text, flip status to reviewed. */
  async stampReplied(id: string, text: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_dm_threads SET replied_at = now(), sent_reply = $2, status = 'reviewed', updated_at = now() WHERE id = $1`,
      [id, text],
    );
  }
}
