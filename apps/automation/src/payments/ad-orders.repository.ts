import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AdOrderRow, AdOrderStatus } from './ad-orders.types';

@Injectable()
export class AdOrdersRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(input: { advertiser: string; channelId?: string | null; amount: string; currency: string; description?: string | null }): Promise<AdOrderRow> {
    const { rows } = await this.pool.query<AdOrderRow>(
      `INSERT INTO ad_orders (advertiser, channel_id, amount, currency, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.advertiser, input.channelId ?? null, input.amount, input.currency, input.description ?? null],
    );
    return rows[0];
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
}
