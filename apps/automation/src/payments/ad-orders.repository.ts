import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AdFormat, AdOrderRow, AdOrderStatus, AdReport } from './ad-orders.types';
import type { SponsoredOrder, SponsoredOrdersPort } from '../editor/publish/sponsored.publisher';

export interface CreateOrderInput {
  advertiser:    string;
  channelId?:    string | null;
  amount:        string;
  currency:      string;
  description?:  string | null;
  priceId?:      string | null;
  creative?:     unknown;
  sponsorLabel?: string | null;
  publishAt?:    Date | null;
  threadId?:     string | null;
}

export interface OrderPatch {
  channelId?:    string | null;
  creative?:     unknown;
  sponsorLabel?: string | null;
  publishAt?:    Date | null;
  threadId?:     string | null;
  description?:  string | null;
}

/** Public, unguessable report id (192 bits, URL-safe). */
export function newReportToken(): string {
  return randomBytes(24).toString('base64url');
}

@Injectable()
export class AdOrdersRepository implements SponsoredOrdersPort {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(input: CreateOrderInput): Promise<AdOrderRow> {
    const { rows } = await this.pool.query<AdOrderRow>(
      `INSERT INTO ad_orders (advertiser, channel_id, amount, currency, description, price_id, creative, sponsor_label, publish_at, thread_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING *`,
      [input.advertiser, input.channelId ?? null, input.amount, input.currency, input.description ?? null,
       input.priceId ?? null, input.creative == null ? null : JSON.stringify(input.creative),
       input.sponsorLabel ?? null, input.publishAt ?? null, input.threadId ?? null],
    );
    return rows[0];
  }

  /** Owner edits of an order that has not been published yet. Returns null when not found or already published. */
  async update(id: string, p: OrderPatch): Promise<AdOrderRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown, cast = '') => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
    if (p.channelId !== undefined)    add('channel_id', p.channelId);
    if (p.creative !== undefined)     add('creative', p.creative === null ? null : JSON.stringify(p.creative), '::jsonb');
    if (p.sponsorLabel !== undefined) add('sponsor_label', p.sponsorLabel);
    if (p.publishAt !== undefined)    add('publish_at', p.publishAt);
    if (p.threadId !== undefined)     add('thread_id', p.threadId);
    if (p.description !== undefined)  add('description', p.description);
    if (!sets.length) return this.findById(id);
    const { rows } = await this.pool.query<AdOrderRow>(
      `UPDATE ad_orders SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 AND status IN ('draft','awaiting_payment','paid','scheduled') RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  }

  async list(status?: AdOrderStatus): Promise<AdOrderRow[]> {
    if (status) {
      const { rows } = await this.pool.query<AdOrderRow>(`SELECT * FROM ad_orders WHERE status = $1 ORDER BY created_at DESC`, [status]);
      return rows;
    }
    const { rows } = await this.pool.query<AdOrderRow>(`SELECT * FROM ad_orders ORDER BY created_at DESC`);
    return rows;
  }

  async findById(id: string): Promise<AdOrderRow | null> {
    const { rows } = await this.pool.query<AdOrderRow>(`SELECT * FROM ad_orders WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Record that checkout was generated: liqpay_order_id = id, status awaiting_payment. */
  async setCheckout(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET liqpay_order_id = $1, status = 'awaiting_payment', updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Idempotent: only a not-yet-paid order flips to paid. */
  async markPaid(liqpayOrderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET status = 'paid', paid_at = now(), updated_at = now()
       WHERE liqpay_order_id = $1 AND status IN ('awaiting_payment','draft')`,
      [liqpayOrderId],
    );
  }

  async attachAction(id: string, actionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET action_id = $2, status = 'scheduled', updated_at = now() WHERE id = $1`,
      [id, actionId],
    );
  }

  /** The approved schedule_post action placed the order: reserved editor slot (or SP2 fallback → slotId null). */
  async setPlacement(id: string, p: { slotId: string | null; publishAt: Date }): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET editor_slot_id = COALESCE($2, editor_slot_id), publish_at = $3, updated_at = now() WHERE id = $1`,
      [id, p.slotId, p.publishAt],
    );
  }

  // ── SponsoredOrdersPort (reserved slot execution) ─────────────────────────

  async findBySlot(slotId: string): Promise<SponsoredOrder | null> {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.advertiser, o.sponsor_label, o.status, o.creative, p.format
         FROM ad_orders o LEFT JOIN ad_prices p ON p.id = o.price_id
        WHERE o.editor_slot_id = $1 ORDER BY o.created_at DESC LIMIT 1`,
      [slotId],
    );
    const r = rows[0];
    return r ? { id: r.id, advertiser: r.advertiser, sponsorLabel: r.sponsor_label ?? null, status: r.status, creative: r.creative ?? null, format: r.format ?? null } : null;
  }

  /** scheduled/paid → published, links the post and issues the public report token. Idempotent. */
  async markPublished(orderId: string, postId: number): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET status = 'published', published_post_id = $2,
              report_token = COALESCE(report_token, $3), updated_at = now()
        WHERE id = $1 AND status IN ('paid','scheduled')`,
      [orderId, postId, newReportToken()],
    );
  }

  // ── reports (T005) ────────────────────────────────────────────────────────

  /**
   * Published orders whose post is old enough for the next report stage:
   * ≥ 24 h and no report yet, or ≥ 72 h and the stored report is not final.
   */
  async dueForReport(now: Date): Promise<Array<AdOrderRow & { posted_at: Date; ad_format: AdFormat | null }>> {
    const { rows } = await this.pool.query(
      `SELECT o.*, p.posted_at, pr.format AS ad_format
         FROM ad_orders o JOIN published_posts p ON p.id = o.published_post_id
         LEFT JOIN ad_prices pr ON pr.id = o.price_id
        WHERE o.status = 'published'
          AND (   (o.report IS NULL AND p.posted_at <= $1::timestamptz - interval '24 hours')
               OR (COALESCE(o.report->>'stage', '') <> '72h' AND p.posted_at <= $1::timestamptz - interval '72 hours'))
        ORDER BY p.posted_at
        LIMIT 50`,
      [now],
    );
    return rows;
  }

  /** Post, channel and stats snapshots a report is built from. */
  async reportInputs(postId: string | number): Promise<{
    post: { messageId: number; postedAt: Date; format: string | null };
    channel: { key: string; title: string | null; username: string | null; subscribers: number | null };
    snapshots: Array<{ capturedAt: Date; views: number | null; forwards: number | null; reactionsTotal: number | null; replies: number | null }>;
  } | null> {
    const { rows } = await this.pool.query(
      `SELECT p.channel_id, p.message_id, p.posted_at, p.format, tc.title, tc.username,
              (SELECT subscribers FROM channel_stats_snapshots s
                WHERE s.channel_id = p.channel_id AND s.subscribers IS NOT NULL
                ORDER BY captured_at DESC LIMIT 1) AS subscribers
         FROM published_posts p LEFT JOIN tracked_channels tc ON tc.channel_key = p.channel_id
        WHERE p.id = $1`, [postId]);
    const r = rows[0];
    if (!r) return null;
    const snaps = await this.pool.query(
      `SELECT captured_at, views, forwards, reactions_total, replies FROM post_stats_snapshots
        WHERE post_id = $1 ORDER BY captured_at LIMIT 500`, [postId]);
    const num = (v: unknown) => (v == null ? null : Number(v));
    return {
      post: { messageId: Number(r.message_id), postedAt: new Date(r.posted_at), format: r.format ?? null },
      channel: { key: r.channel_id, title: r.title ?? null, username: r.username ?? null, subscribers: num(r.subscribers) },
      snapshots: snaps.rows.map((s: any) => ({
        capturedAt: new Date(s.captured_at), views: num(s.views), forwards: num(s.forwards),
        reactionsTotal: num(s.reactions_total), replies: num(s.replies),
      })),
    };
  }

  /** Store a report; the final (72 h) stage moves the order to `reported`. Returns the public token. */
  async saveReport(id: string, report: AdReport): Promise<string | null> {
    const final = report.stage === '72h';
    const { rows } = await this.pool.query(
      `UPDATE ad_orders SET report = $2::jsonb, report_token = COALESCE(report_token, $3),
              status = CASE WHEN $4 THEN 'reported' ELSE status END,
              reported_at = CASE WHEN $4 THEN now() ELSE reported_at END,
              updated_at = now()
        WHERE id = $1 AND status = 'published'
        RETURNING report_token`,
      [id, JSON.stringify(report), newReportToken(), final],
    );
    return rows[0]?.report_token ?? null;
  }

  /** Public report lookup by token — only the report JSON leaves the DB. */
  async reportByToken(token: string): Promise<AdReport | null> {
    const { rows } = await this.pool.query(`SELECT report FROM ad_orders WHERE report_token = $1 AND report IS NOT NULL`, [token]);
    return rows[0]?.report ?? null;
  }
}
