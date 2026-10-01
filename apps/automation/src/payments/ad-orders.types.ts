export type AdOrderStatus = 'draft' | 'awaiting_payment' | 'paid' | 'scheduled' | 'published' | 'reported' | 'canceled';
export type AdFormat = 'post' | 'pin_24h' | 'digest_sponsor';
export const AD_FORMATS: readonly AdFormat[] = ['post', 'pin_24h', 'digest_sponsor'];

export interface AdOrderRow {
  id: string; advertiser: string; channel_id: string | null;
  amount: string; currency: string; description: string | null;
  status: AdOrderStatus; liqpay_order_id: string | null; action_id: string | null;
  paid_at: Date | null; created_at: Date; updated_at: Date;
  // 044_ad_revenue
  price_id:          string | null;
  creative:          unknown;
  sponsor_label:     string | null;
  publish_at:        Date | null;
  editor_slot_id:    string | null;
  published_post_id: string | null; // bigint → string
  thread_id:         string | null;
  report:            AdReport | null;
  reported_at:       Date | null;
  report_token:      string | null;
}

export interface AdPriceRow {
  id: string; channel_key: string; format: AdFormat; price_uah: number;
  active: boolean; note: string | null; created_at: Date;
}

/** Public projection of a price (no ids, no internals). */
export interface PublicAdPrice {
  channelKey: string;
  format:     AdFormat;
  priceUah:   number;
  note:       string | null;
}

export type AdReportStage = '24h' | '72h';

export interface AdReportPoint { hours: number; views: number | null }

/** Stored in ad_orders.report and served at GET /api/ads/report/:token. */
export interface AdReport {
  stage:       AdReportStage;
  generatedAt: string;
  advertiser:  string;
  channel:     { key: string; title: string | null; url: string | null; subscribers: number | null };
  post:        { url: string | null; publishedAt: string; format: string | null };
  metrics:     { views: number | null; forwards: number | null; reactions: number | null; replies: number | null; capturedAt: string | null };
  /** views / subscribers at report time — a reach proxy (null when either is unknown). */
  reachRate:   number | null;
  /**
   * The advertiser's link as published. Telegram exposes no clicks; when the
   * link carries UTM tags (digest sponsor links always do) clicks are readable
   * in the advertiser's own analytics — the CTR proxy.
   */
  link:        { url: string; utm: boolean } | null;
  curve:       AdReportPoint[];
}
