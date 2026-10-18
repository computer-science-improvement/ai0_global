import type { Pool } from 'pg';

/**
 * The items behind the menu counters (`GET /api/nav/attention`): a page the owner opens from a badge shows
 * exactly what waits — the unread Inbox notes, the directives that need a decision and the chat cards still to
 * confirm — with a link to each. Every list is capped; a missing table answers an empty list.
 */
export const ATTENTION_LIMIT = 8;

export interface AttentionInboxItem { id: number; title: string; severity: 'info' | 'action' | 'critical'; kind: string; agentHandle: string | null; createdAt: string }
export interface AttentionDirective { id: string; kind: string; body: string; status: string; agentHandle: string | null; createdAt: string }
export interface AttentionChatCard { id: string; chatId: string | null; chatTitle: string | null; kind: string; summary: string; agentHandle: string | null; createdAt: string }

export interface NavAttention {
  inbox:      { total: number; items: AttentionInboxItem[] };
  directives: { total: number; items: AttentionDirective[] };
  chatCards:  { total: number; items: AttentionChatCard[] };
}

/** A chat card older than the pending-action TTL (24 h) can no longer be applied: it is not waiting. */
export function chatCardLive(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `${a}status = 'pending' AND ${a}created_at > now() - interval '24 hours'`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class NavAttentionService {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async get(): Promise<NavAttention> {
    const [inbox, directives, chatCards] = await Promise.all([this.inbox(), this.directives(), this.chatCards()]);
    return { inbox, directives, chatCards };
  }

  private async safe<T>(fn: () => Promise<{ total: number; items: T[] }>): Promise<{ total: number; items: T[] }> {
    try { return await fn(); } catch (err: any) {
      if (err?.code === '42P01' || err?.code === '42703') return { total: 0, items: [] }; // an older DB
      throw err;
    }
  }

  private inbox() {
    return this.safe<AttentionInboxItem>(async () => {
      const { rows } = await this.pool.query(
        `SELECT i.id, i.title, i.severity, i.kind, i.created_at, a.handle, count(*) OVER () AS total
           FROM agent_inbox i LEFT JOIN agents a ON a.id = i.agent_id
          WHERE i.read_at IS NULL
          ORDER BY (i.severity = 'critical') DESC, (i.severity = 'action') DESC, i.created_at DESC LIMIT $1`, [ATTENTION_LIMIT]);
      return {
        total: Number(rows[0]?.total ?? 0),
        items: rows.map((r) => ({ id: Number(r.id), title: clip(String(r.title), 200), severity: r.severity, kind: r.kind, agentHandle: r.handle ?? null, createdAt: new Date(r.created_at).toISOString() })),
      };
    });
  }

  private directives() {
    return this.safe<AttentionDirective>(async () => {
      const { rows } = await this.pool.query(
        `SELECT d.id, d.kind, d.body, d.status, d.created_at, a.handle, count(*) OVER () AS total
           FROM agent_directives d LEFT JOIN agents a ON a.id = d.to_agent_id
          WHERE d.status IN ('awaiting_owner', 'contested')
          ORDER BY d.created_at DESC LIMIT $1`, [ATTENTION_LIMIT]);
      return {
        total: Number(rows[0]?.total ?? 0),
        items: rows.map((r) => ({ id: r.id, kind: r.kind, body: clip(String(r.body), 200), status: r.status, agentHandle: r.handle ?? null, createdAt: new Date(r.created_at).toISOString() })),
      };
    });
  }

  private chatCards() {
    return this.safe<AttentionChatCard>(async () => {
      const { rows } = await this.pool.query(
        `SELECT p.id, p.chat_id, c.title, p.kind, p.summary, p.created_at, a.handle, count(*) OVER () AS total
           FROM pending_actions p LEFT JOIN editor_chats c ON c.id = p.chat_id LEFT JOIN agents a ON a.id = p.agent_id
          WHERE ${chatCardLive('p')}
          ORDER BY p.created_at DESC LIMIT $1`, [ATTENTION_LIMIT]);
      return {
        total: Number(rows[0]?.total ?? 0),
        items: rows.map((r) => ({
          id: r.id, chatId: r.chat_id ?? null, chatTitle: r.title ?? null, kind: r.kind, summary: clip(String(r.summary), 200),
          agentHandle: r.handle ?? null, createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    });
  }
}
