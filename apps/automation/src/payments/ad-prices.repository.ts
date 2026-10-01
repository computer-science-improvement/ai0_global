import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AdFormat, AdPriceRow, PublicAdPrice } from './ad-orders.types';

export interface MediaKitChannel {
  channelKey:  string;
  title:       string | null;
  url:         string | null;
  subscribers: number | null;
  /** Average latest views per post published in the last 30 days (all strategies). */
  avgViews30d: number | null;
  posts30d:    number;
  prices:      Array<{ format: AdFormat; priceUah: number; note: string | null }>;
}

export function toPublicPrice(r: AdPriceRow): PublicAdPrice {
  return { channelKey: r.channel_key, format: r.format, priceUah: Number(r.price_uah), note: r.note ?? null };
}

@Injectable()
export class AdPricesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(opts: { activeOnly?: boolean; channelKey?: string } = {}): Promise<AdPriceRow[]> {
    const { rows } = await this.pool.query<AdPriceRow>(
      `SELECT * FROM ad_prices
        WHERE ($1::boolean IS NOT TRUE OR active) AND ($2::text IS NULL OR channel_key = $2)
        ORDER BY channel_key, format, active DESC, created_at DESC`,
      [opts.activeOnly ?? false, opts.channelKey ?? null],
    );
    return rows;
  }

  async findById(id: string): Promise<AdPriceRow | null> {
    const { rows } = await this.pool.query<AdPriceRow>(`SELECT * FROM ad_prices WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Set the price of a channel+format: the previous active price is kept as inactive history. */
  async upsertActive(i: { channelKey: string; format: AdFormat; priceUah: number; note?: string | null }): Promise<AdPriceRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE ad_prices SET active = false WHERE channel_key = $1 AND format = $2 AND active`, [i.channelKey, i.format]);
      const { rows } = await client.query<AdPriceRow>(
        `INSERT INTO ad_prices (channel_key, format, price_uah, note) VALUES ($1, $2, $3, $4) RETURNING *`,
        [i.channelKey, i.format, i.priceUah, i.note ?? null]);
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async deactivate(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`UPDATE ad_prices SET active = false WHERE id = $1 AND active`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Media kit (T008): every channel with at least one active price, with live
   * stats — latest subscriber count and the average latest views of posts from
   * the last 30 days (editor_v_post_performance covers all strategies).
   */
  async mediaKit(): Promise<MediaKitChannel[]> {
    const { rows } = await this.pool.query(
      `WITH ch AS (SELECT DISTINCT channel_key FROM ad_prices WHERE active)
       SELECT ch.channel_key,
              tc.title, tc.username,
              (SELECT subscribers FROM channel_stats_snapshots s
                WHERE s.channel_id = ch.channel_key AND s.subscribers IS NOT NULL
                ORDER BY captured_at DESC LIMIT 1) AS subscribers,
              perf.avg_views, COALESCE(perf.posts, 0) AS posts,
              (SELECT json_agg(json_build_object('format', p.format, 'priceUah', p.price_uah, 'note', p.note) ORDER BY p.format)
                 FROM ad_prices p WHERE p.channel_key = ch.channel_key AND p.active) AS prices
         FROM ch
         LEFT JOIN tracked_channels tc ON tc.channel_key = ch.channel_key
         LEFT JOIN LATERAL (
           SELECT ROUND(AVG(views))::int AS avg_views, COUNT(*)::int AS posts
             FROM editor_v_post_performance v
            WHERE v.channel_id = ch.channel_key AND v.posted_at >= now() - interval '30 days'
              AND COALESCE(v.strategy_type, '') <> 'ad'
         ) perf ON true
        ORDER BY subscribers DESC NULLS LAST, ch.channel_key`,
    );
    return rows.map((r: any) => {
      const handle = (r.username as string | null) ?? (String(r.channel_key).startsWith('@') ? String(r.channel_key).slice(1) : null);
      return {
        channelKey:  r.channel_key,
        title:       r.title ?? null,
        url:         handle ? `https://t.me/${handle.replace(/^@/, '')}` : null,
        subscribers: r.subscribers == null ? null : Number(r.subscribers),
        avgViews30d: r.avg_views == null ? null : Number(r.avg_views),
        posts30d:    Number(r.posts),
        prices:      (r.prices ?? []).map((p: any) => ({ format: p.format, priceUah: Number(p.priceUah), note: p.note ?? null })),
      };
    });
  }
}
