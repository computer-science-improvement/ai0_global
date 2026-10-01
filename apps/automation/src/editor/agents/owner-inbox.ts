import type { Pool } from 'pg';

export type InboxSeverity = 'info' | 'action' | 'critical';

export interface InboxItemInput {
  agentId?:  string | null;
  kind:      string;
  title:     string;
  body?:     string | null;
  refType?:  string | null;
  refId?:    string | null;
  severity?: InboxSeverity;
}

export interface InboxItem extends Required<Omit<InboxItemInput, 'agentId'>> {
  id:        number;
  agentId:   string | null;
  readAt:    Date | null;
  createdAt: Date;
}

/**
 * The owner's inbox for agent events (skill self-edits, rollbacks, cards that
 * need a decision). Every item is stored and also pushed to the admin bot as a
 * plain alert; the 012 owner bot will later replace the alert with a card.
 */
export class OwnerInbox {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly alert: (text: string) => Promise<void> = async () => {},
    private readonly dashboardUrl: string | null = null,
  ) {}

  async post(i: InboxItemInput): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO agent_inbox (agent_id, kind, title, body, ref_type, ref_id, severity) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [i.agentId ?? null, i.kind, i.title.slice(0, 300), i.body ?? null, i.refType ?? null, i.refId ?? null, i.severity ?? 'info']);
    const link = this.dashboardUrl ? `\n${this.dashboardUrl.replace(/\/$/, '')}/app/agents/inbox` : '';
    try {
      await this.alert(`${i.severity === 'critical' ? '🚨' : i.severity === 'action' ? '🟡' : '🤖'} ${i.title}${i.body ? `\n\n${i.body.slice(0, 1500)}` : ''}${link}`);
    } catch { /* the stored item is what matters */ }
    return Number(rows[0].id);
  }

  async list(o: { unreadOnly?: boolean; limit?: number } = {}): Promise<InboxItem[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_inbox WHERE ($1::bool IS NOT TRUE OR read_at IS NULL) ORDER BY created_at DESC LIMIT $2`,
      [o.unreadOnly ?? false, o.limit ?? 100]);
    return rows.map((r) => ({
      id: Number(r.id), agentId: r.agent_id ?? null, kind: r.kind, title: r.title, body: r.body ?? null,
      refType: r.ref_type ?? null, refId: r.ref_id ?? null, severity: r.severity, readAt: r.read_at ?? null, createdAt: r.created_at,
    })) as InboxItem[];
  }

  async markRead(ids: number[] | 'all'): Promise<number> {
    const { rowCount } = ids === 'all'
      ? await this.pool.query(`UPDATE agent_inbox SET read_at = now() WHERE read_at IS NULL`)
      : await this.pool.query(`UPDATE agent_inbox SET read_at = now() WHERE id = ANY($1::bigint[]) AND read_at IS NULL`, [ids]);
    return rowCount ?? 0;
  }
}
