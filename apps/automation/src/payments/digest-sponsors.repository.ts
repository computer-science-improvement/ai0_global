import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { inlineToPlain } from '../editor/post/inline-markup';
import { newReportToken } from './ad-orders.repository';

export interface DigestSponsor {
  orderId: string;
  text:    string;
  /** The advertiser's link as given (UTM is added by the digest). */
  url:     string;
}

/** Sponsor line text: the creative's first block, else the order description, else the advertiser. */
export function sponsorFromOrder(r: { id: string; advertiser: string; description: string | null; creative: any }): DigestSponsor | null {
  const c = r.creative ?? {};
  const url: string | undefined = c.cta?.url ?? c.buttons?.[0]?.[0]?.url;
  if (!url) return null;
  const first = Array.isArray(c.body) ? c.body[0] : null;
  const raw = first ? (first.type === 'list' ? (first.items ?? []).join(', ') : first.text ?? '') : '';
  const text = (inlineToPlain(String(raw)).trim() || r.description?.trim() || r.advertiser).slice(0, 140);
  return { orderId: r.id, text, url };
}

/**
 * Paid `digest_sponsor` orders for the digest strategies (spec 008 T006).
 * The order's channel is its explicit channel_id (uuid or key), else the
 * price's channel; its publish_at Kyiv date is the digest day.
 */
@Injectable()
export class DigestSponsorsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async findForDay(channelKey: string, kyivDay: string): Promise<DigestSponsor | null> {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.advertiser, o.description, o.creative
         FROM ad_orders o JOIN ad_prices p ON p.id = o.price_id
        WHERE p.format = 'digest_sponsor'
          AND o.status IN ('paid','scheduled')
          AND o.publish_at IS NOT NULL
          AND (o.publish_at AT TIME ZONE 'Europe/Kyiv')::date = $2::date
          AND (COALESCE(o.channel_id, p.channel_key) = $1
               OR COALESCE(o.channel_id, p.channel_key) IN (SELECT id::text FROM tracked_channels WHERE channel_key = $1))
        ORDER BY o.paid_at NULLS LAST, o.created_at`,
      [channelKey, kyivDay]);
    for (const r of rows) {
      const s = sponsorFromOrder(r);
      if (s) return s;
    }
    return null;
  }

  /** Order → published, linked to the digest post (published_posts row by channel + message id). */
  async markPublished(orderId: string, channelKey: string, messageId: string | number): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET status = 'published',
              published_post_id = (SELECT id FROM published_posts WHERE channel_id = $2 AND message_id = $3),
              report_token = COALESCE(report_token, $4), updated_at = now()
        WHERE id = $1 AND status IN ('paid','scheduled')`,
      [orderId, channelKey, Number(messageId), newReportToken()]);
  }
}
