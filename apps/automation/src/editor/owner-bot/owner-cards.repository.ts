import type { Pool } from 'pg';

export type CardStatus = 'queued' | 'open' | 'done' | 'closed' | 'failed';

/** A button stored on the card; the callback data only carries the card id and the button's index. */
export interface CardButton {
  key:      string;
  label:    string;
  /** A URL button (Відкрити). */
  url?:     string;
  /** Asks to confirm first: the label of the confirming button ("Так, застосувати все"). */
  confirm?: string;
}

export interface OwnerCard {
  id:         number;
  kind:       string;
  refId:      string;
  status:     CardStatus;
  critical:   boolean;
  title:      string;
  body:       string | null;
  buttons:    CardButton[];
  link:       string | null;
  chatId:     string | null;
  messageId:  number | null;
  outcome:    string | null;
  resolvedBy: string | null;
  attempts:   number;
  lastError:  string | null;
  createdAt:  Date;
  sentAt:     Date | null;
  resolvedAt: Date | null;
}

export interface NewCard {
  kind:      string;
  refId:     string;
  critical?: boolean;
  title:     string;
  body?:     string | null;
  buttons:   CardButton[];
  link?:     string | null;
}

const toCard = (r: any): OwnerCard => ({
  id: Number(r.id), kind: r.kind, refId: r.ref_id, status: r.status, critical: !!r.critical, title: r.title, body: r.body ?? null,
  buttons: Array.isArray(r.buttons) ? r.buttons : [], link: r.link ?? null, chatId: r.chat_id ?? null,
  messageId: r.message_id == null ? null : Number(r.message_id), outcome: r.outcome ?? null, resolvedBy: r.resolved_by ?? null,
  attempts: Number(r.attempts ?? 0), lastError: r.last_error ?? null, createdAt: r.created_at, sentAt: r.sent_at ?? null,
  resolvedAt: r.resolved_at ?? null,
});

export const MAX_ATTEMPTS = 5;

export class OwnerCardsRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /** A new card, queued; null when this item already has one (any status). */
  async insert(c: NewCard): Promise<OwnerCard | null> {
    const { rows } = await this.pool.query(
      `INSERT INTO owner_cards (kind, ref_id, critical, title, body, buttons, link)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (kind, ref_id) DO NOTHING RETURNING *`,
      [c.kind, c.refId, c.critical ?? false, c.title.slice(0, 500), c.body ?? null, JSON.stringify(c.buttons), c.link ?? null]);
    return rows[0] ? toCard(rows[0]) : null;
  }

  async get(id: number): Promise<OwnerCard | null> {
    const { rows } = await this.pool.query(`SELECT * FROM owner_cards WHERE id = $1`, [id]);
    return rows[0] ? toCard(rows[0]) : null;
  }

  /** Cards still waiting for the owner (queued or sent), oldest first. */
  async live(): Promise<OwnerCard[]> {
    const { rows } = await this.pool.query(`SELECT * FROM owner_cards WHERE status IN ('queued', 'open') ORDER BY created_at, id`);
    return rows.map(toCard);
  }

  /** Queued cards in send order: critical first, then the oldest. */
  async queued(limit: number): Promise<OwnerCard[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM owner_cards WHERE status = 'queued' ORDER BY critical DESC, created_at, id LIMIT $1`, [limit]);
    return rows.map(toCard);
  }

  /** The cards of these items (any status). */
  async byRefs(kind: string, refIds: string[]): Promise<OwnerCard[]> {
    if (!refIds.length) return [];
    const { rows } = await this.pool.query(`SELECT * FROM owner_cards WHERE kind = $1 AND ref_id = ANY($2::text[])`, [kind, refIds]);
    return rows.map(toCard);
  }

  /** A failed or closed card whose item still waits goes back to the queue (/waiting). */
  async requeue(id: number): Promise<OwnerCard | null> {
    const { rows } = await this.pool.query(
      `UPDATE owner_cards SET status = 'queued', attempts = 0, last_error = NULL, outcome = NULL, resolved_by = NULL, resolved_at = NULL,
              chat_id = NULL, message_id = NULL, sent_at = NULL
        WHERE id = $1 AND status IN ('failed', 'closed') RETURNING *`, [id]);
    return rows[0] ? toCard(rows[0]) : null;
  }

  /** A queued card whose item became urgent (a post due soon) jumps the quiet hours and the hourly limit. */
  async markCritical(id: number): Promise<void> {
    await this.pool.query(`UPDATE owner_cards SET critical = true WHERE id = $1 AND status = 'queued'`, [id]);
  }

  async markSent(id: number, chatId: string, messageId: number): Promise<void> {
    await this.pool.query(
      `UPDATE owner_cards SET status = 'open', chat_id = $2, message_id = $3, sent_at = now(), last_error = NULL
        WHERE id = $1 AND status = 'queued'`, [id, chatId, messageId]);
  }

  /** A failed send: counted; the card fails after MAX_ATTEMPTS. */
  async markAttempt(id: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE owner_cards SET attempts = attempts + 1, last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END
        WHERE id = $1 AND status = 'queued'`, [id, error.slice(0, 500), MAX_ATTEMPTS]);
  }

  /** Settles a live card once: done (the owner acted here) or closed (decided elsewhere, expired). Null when it was not live. */
  async resolve(id: number, status: 'done' | 'closed', outcome: string, by: string | null): Promise<OwnerCard | null> {
    const { rows } = await this.pool.query(
      `UPDATE owner_cards SET status = $2, outcome = $3, resolved_by = $4, resolved_at = now()
        WHERE id = $1 AND status IN ('queued', 'open') RETURNING *`, [id, status, outcome.slice(0, 300), by]);
    return rows[0] ? toCard(rows[0]) : null;
  }

  /** Cards sent since `since` (the hourly limit). */
  async sentSince(since: Date): Promise<number> {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM owner_cards WHERE sent_at >= $1`, [since]);
    return Number(rows[0]?.n ?? 0);
  }

  async counts(since: Date): Promise<{ open: number; queued: number; sentToday: number; failed: number }> {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE sent_at >= $1)::int AS sent,
              count(*) FILTER (WHERE status = 'failed' AND created_at >= $1)::int AS failed
         FROM owner_cards`, [since]);
    const r = rows[0] ?? {};
    return { open: Number(r.open ?? 0), queued: Number(r.queued ?? 0), sentToday: Number(r.sent ?? 0), failed: Number(r.failed ?? 0) };
  }

  /** Claims a report for its period; false when it was already sent. */
  async claimReport(kind: 'daily' | 'weekly', period: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO owner_reports (kind, period) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [kind, period]);
    return (rowCount ?? 0) > 0;
  }

  async releaseReport(kind: 'daily' | 'weekly', period: string): Promise<void> {
    await this.pool.query(`DELETE FROM owner_reports WHERE kind = $1 AND period = $2`, [kind, period]);
  }

  async lastReports(): Promise<{ daily: Date | null; weekly: Date | null }> {
    const { rows } = await this.pool.query(`SELECT kind, max(sent_at) AS at FROM owner_reports GROUP BY kind`);
    const at = (k: string) => rows.find((r: any) => r.kind === k)?.at ?? null;
    return { daily: at('daily'), weekly: at('weekly') };
  }
}
