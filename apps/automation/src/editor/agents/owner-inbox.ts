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
  /**
   * The Telegram alert's own wording when it differs from the stored item:
   * dashboard copy is English (AI0-79) while the owner's Telegram alerts stay
   * as they were until the owner decides. Without it the alert repeats title/body.
   */
  alert?:    { title: string; body?: string | null } | null;
}

/**
 * Spec 037 FR-010 (T10): the silent-day alerts, at most one note per resource per (local) day and kind
 * (`postOnce` with `dailyRef`; a unique partial index of migration 076 backs the dedup).
 */
export const SILENT_DAY_KINDS = ['dark_day', 'series_missed', 'critic_reject_streak'] as const;
export type SilentDayKind = typeof SILENT_DAY_KINDS[number];
export const RESOURCE_DAY_REF = 'resource_day';

/** The dedup key of a once-per-resource-per-day note: ref_type `resource_day`, ref_id `<resource_ref>|<YYYY-MM-DD>`. */
export function dailyRef(resourceRef: string, day: string): { refType: string; refId: string } {
  return { refType: RESOURCE_DAY_REF, refId: `${resourceRef}|${day}` };
}

export interface InboxItem extends Required<Omit<InboxItemInput, 'agentId' | 'alert'>> {
  id:        number;
  agentId:   string | null;
  readAt:    Date | null;
  createdAt: Date;
}

/**
 * Spec 012 FR-002: while the owner bot's cards are on, a stored note goes to the bot instead of the plain alert (a
 * critical or action note becomes a card, an info note waits for the daily summary). The sink returns true when it
 * took the note; false (or a throw) falls back to the alert. Module-level, as every OwnerInbox shares the one bot.
 */
export type InboxCardSink = (id: number, i: InboxItemInput) => Promise<boolean>;
let cardSink: InboxCardSink | null = null;
export function setInboxCardSink(sink: InboxCardSink | null): void { cardSink = sink; }

/**
 * The owner's inbox for agent events (skill self-edits, rollbacks, cards that
 * need a decision). Every item is stored and also pushed to the admin bot: as a
 * card while the 012 owner bot's cards are on, else as a plain alert.
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
    await this.deliver(Number(rows[0].id), i);
    return Number(rows[0].id);
  }

  /**
   * Store and alert only when no item of the same kind and ref exists yet (the once-per-resource-per-day notes,
   * spec 037 FR-010). Returns the new id, or null when it was a duplicate (no alert either).
   */
  async postOnce(i: InboxItemInput & { refType: string; refId: string }): Promise<number | null> {
    let rows: any[];
    try {
      ({ rows } = await this.pool.query(
        `INSERT INTO agent_inbox (agent_id, kind, title, body, ref_type, ref_id, severity)
         SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text
          WHERE NOT EXISTS (SELECT 1 FROM agent_inbox WHERE kind = $2 AND ref_type = $5 AND ref_id = $6)
         RETURNING id`,
        [i.agentId ?? null, i.kind, i.title.slice(0, 300), i.body ?? null, i.refType, i.refId, i.severity ?? 'info']));
    } catch (err: any) {
      if (err?.code === '23505') return null; // a concurrent insert won the unique index (migration 076)
      throw err;
    }
    if (!rows.length) return null;
    await this.deliver(Number(rows[0].id), i);
    return Number(rows[0].id);
  }

  private async deliver(id: number, i: InboxItemInput): Promise<void> {
    if (cardSink) {
      try {
        if (await cardSink(id, i)) return;
      } catch { /* the plain alert below */ }
    }
    await this.sendAlert(i);
  }

  private async sendAlert(i: InboxItemInput): Promise<void> {
    const link = this.dashboardUrl ? `\n${this.dashboardUrl.replace(/\/$/, '')}/app/agents/inbox` : '';
    const title = i.alert ? i.alert.title : i.title;
    const body = i.alert ? i.alert.body : i.body;
    try {
      await this.alert(`${i.severity === 'critical' ? '🚨' : i.severity === 'action' ? '🟡' : '🤖'} ${title}${body ? `\n\n${body.slice(0, 1500)}` : ''}${link}`);
    } catch { /* the stored item is what matters */ }
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
