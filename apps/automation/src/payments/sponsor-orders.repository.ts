import type { Pool } from 'pg';

/**
 * Spec 036: the SQL side of digest-sponsor fulfilment, the sale guard and the stuck-order check.
 *
 * A `digest_sponsor` order used to be embedded by the legacy digest strategies (network-digest / topic-digest)
 * while an enabled binding of one of them published to the order's channel. Spec 023 phase B removed the strategy
 * runtime: no digest strategy runs anywhere, whatever `strategy_bindings.enabled` says, so every open digest
 * sponsor goes to the reserved lane as a standalone sponsored post and the price is not offered for sale.
 */

type Q = Pick<Pool, 'query'>;

/** Legacy strategy types that embedded the paid "Партнер дайджесту" line (spec 008 T006); history only. */
export const DIGEST_STRATEGY_TYPES = ['network-digest', 'topic-digest'] as const;

/**
 * SQL predicate: a legacy digest strategy publishes to the Telegram channel `keyExpr` (a channel_key). Always
 * FALSE since spec 023 phase B (the strategy runtime is gone; an enabled binding no longer runs). Kept as one
 * predicate so the sale guard, fulfilment and the stuck check stay in agreement.
 */
export function digestRunsOnSql(_keyExpr: string): string {
  return 'FALSE';
}

/** SQL predicate on an ad_prices row: the price may be offered (a digest sponsor only where a digest still runs). */
export function sellablePriceSql(alias = 'p'): string {
  return `(${alias}.format <> 'digest_sponsor' OR ${digestRunsOnSql(`${alias}.channel_key`)})`;
}

/** SQL: the order's channel_key — ad_orders.channel_id is a channel_key or a tracked_channels uuid; else the price's channel. */
const ORDER_CHANNEL_SQL = `COALESCE(
    (SELECT tc.channel_key FROM tracked_channels tc WHERE tc.id::text = COALESCE(o.channel_id, p.channel_key)),
    COALESCE(o.channel_id, p.channel_key))`;

export interface SponsorOrder {
  id:           string;
  advertiser:   string;
  sponsorLabel: string | null;
  status:       string;
  creative:     unknown;
  publishAt:    Date | null;
  /** The resolved channel_key (null when the order names no channel). */
  channelKey:   string | null;
  /** A legacy digest strategy embeds the sponsor (always false since spec 023 phase B). */
  digestRuns:   boolean;
  flagReason:   string | null;
}

export interface OpenOrderRow {
  id:            string;
  advertiser:    string;
  status:        string;
  amount:        string;
  currency:      string;
  format:        string | null;
  channelKey:    string | null;
  publishAt:     Date | null;
  paidAt:        Date | null;
  createdAt:     Date;
  flagReason:    string | null;
  editorSlotId:  string | null;
  slotStatus:    string | null;
  actionStatus:  string | null;
}

const toSponsor = (r: any): SponsorOrder => ({
  id: r.id, advertiser: r.advertiser, sponsorLabel: r.sponsor_label ?? null, status: r.status, creative: r.creative ?? null,
  publishAt: r.publish_at ? new Date(r.publish_at) : null, channelKey: r.channel_key ?? null, digestRuns: !!r.digest_runs,
  flagReason: r.flag_reason ?? null,
});

export class SponsorOrdersRepository {
  constructor(private readonly pool: Q) {}

  /** Paid digest_sponsor orders not placed and not published yet (the fulfilment tick's input). */
  async openDigestSponsors(): Promise<SponsorOrder[]> {
    const { rows } = await this.pool.query(
      `SELECT x.*, ${digestRunsOnSql('x.channel_key')} AS digest_runs FROM (
         SELECT o.id, o.advertiser, o.sponsor_label, o.status, o.creative, o.publish_at, o.flag_reason, ${ORDER_CHANNEL_SQL} AS channel_key
           FROM ad_orders o JOIN ad_prices p ON p.id = o.price_id
          WHERE p.format = 'digest_sponsor' AND o.status IN ('paid','scheduled')
            AND o.editor_slot_id IS NULL AND o.published_post_id IS NULL
       ) x
       ORDER BY x.publish_at NULLS FIRST, x.id`);
    return rows.map(toSponsor);
  }

  /** Every not-yet-published digest_sponsor order (sold or paid, not placed) on any of the channels. */
  async digestSponsorsOn(channelKeys: string[]): Promise<SponsorOrder[]> {
    if (!channelKeys.length) return [];
    const { rows } = await this.pool.query(
      `SELECT x.*, ${digestRunsOnSql('x.channel_key')} AS digest_runs FROM (
         SELECT o.id, o.advertiser, o.sponsor_label, o.status, o.creative, o.publish_at, o.flag_reason, ${ORDER_CHANNEL_SQL} AS channel_key
           FROM ad_orders o JOIN ad_prices p ON p.id = o.price_id
          WHERE p.format = 'digest_sponsor' AND o.status IN ('draft','awaiting_payment','paid','scheduled')
            AND o.editor_slot_id IS NULL AND o.published_post_id IS NULL
       ) x
       WHERE x.channel_key = ANY($1::text[])
       ORDER BY x.publish_at NULLS FIRST, x.id`, [channelKeys]);
    return rows.map(toSponsor);
  }

  /** Active digest_sponsor prices on the channels (no longer offered once no digest runs there). */
  async digestSponsorPricesOn(channelKeys: string[]): Promise<Array<{ channelKey: string; priceUah: number }>> {
    if (!channelKeys.length) return [];
    const { rows } = await this.pool.query(
      `SELECT channel_key, price_uah FROM ad_prices WHERE active AND format = 'digest_sponsor' AND channel_key = ANY($1::text[]) ORDER BY channel_key`,
      [channelKeys]);
    return rows.map((r) => ({ channelKey: r.channel_key, priceUah: Number(r.price_uah) }));
  }

  /** Does a legacy digest strategy publish to this channel? Always false since spec 023 phase B (kept for the callers). */
  async digestRunsOn(channelIdOrKey: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT ${digestRunsOnSql('k.key')} AS runs
         FROM (SELECT COALESCE((SELECT channel_key FROM tracked_channels WHERE id::text = $1), $1) AS key) k`,
      [channelIdOrKey]);
    return !!rows[0]?.runs;
  }

  /**
   * Local HH:MM times of the agents' digest-like series on the channel: active series of an active playbook
   * whose source is `network_highlights` (what the digest strategies map to, spec 023), with the cadence.
   */
  async digestCadences(channelKey: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT s->>'cadence' AS cadence
         FROM playbooks pb, jsonb_array_elements(CASE WHEN jsonb_typeof(pb.body->'series') = 'array' THEN pb.body->'series' ELSE '[]'::jsonb END) s
        WHERE pb.status = 'active' AND s->>'resource_ref' = $1
          AND s->'source'->>'kind' = 'network_highlights' AND COALESCE(s->>'active', 'true') <> 'false'`,
      [`telegram:${channelKey}`]);
    return rows.map((r) => String(r.cadence)).filter(Boolean);
  }

  /**
   * The order is placed in the reserved lane: slot linked, publish time set, status `scheduled`, flag cleared.
   * Guarded (still open and unplaced) so a second tick can never place it twice. False = someone else won.
   */
  async place(orderId: string, slotId: string, at: Date): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ad_orders SET editor_slot_id = $2, publish_at = $3, status = 'scheduled', flag_reason = NULL, flagged_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('paid','scheduled') AND editor_slot_id IS NULL AND published_post_id IS NULL`,
      [orderId, slotId, at]);
    return (rowCount ?? 0) > 0;
  }

  /** A reserved slot whose order was placed by someone else is dropped (never published). */
  async dropSlot(slotId: string, why: string): Promise<void> {
    await this.pool.query(`UPDATE editor_slots SET status = 'skipped', error = $2, updated_at = now() WHERE id = $1 AND status = 'planned'`, [slotId, why]);
  }

  /** Record why the order is stuck. True only when the reason is new (the caller alerts once per reason). */
  async flag(orderId: string, reason: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ad_orders SET flag_reason = $2, flagged_at = now(), updated_at = now() WHERE id = $1 AND flag_reason IS DISTINCT FROM $2`,
      [orderId, reason.slice(0, 300)]);
    return (rowCount ?? 0) > 0;
  }

  /** Paid or scheduled orders that have not been published, with their placement state (the stuck check's input). */
  async openOrders(): Promise<OpenOrderRow[]> {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.advertiser, o.status, o.amount::text AS amount, o.currency, p.format, ${ORDER_CHANNEL_SQL} AS channel_key,
              o.publish_at, o.paid_at, o.created_at, o.flag_reason, o.editor_slot_id, s.status AS slot_status, a.status AS action_status
         FROM ad_orders o
         LEFT JOIN ad_prices p ON p.id = o.price_id
         LEFT JOIN editor_slots s ON s.id = o.editor_slot_id
         LEFT JOIN agent_actions a ON a.id = o.action_id
        WHERE o.status IN ('paid','scheduled') AND o.published_post_id IS NULL
        ORDER BY o.publish_at NULLS FIRST, o.created_at`);
    return rows.map((r: any) => ({
      id: r.id, advertiser: r.advertiser, status: r.status, amount: String(r.amount), currency: r.currency, format: r.format ?? null,
      channelKey: r.channel_key ?? null, publishAt: r.publish_at ? new Date(r.publish_at) : null, paidAt: r.paid_at ? new Date(r.paid_at) : null,
      createdAt: new Date(r.created_at), flagReason: r.flag_reason ?? null, editorSlotId: r.editor_slot_id ?? null,
      slotStatus: r.slot_status ?? null, actionStatus: r.action_status ?? null,
    }));
  }
}
