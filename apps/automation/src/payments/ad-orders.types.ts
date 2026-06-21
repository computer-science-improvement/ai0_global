export type AdOrderStatus = 'draft' | 'awaiting_payment' | 'paid' | 'scheduled' | 'canceled';
export interface AdOrderRow {
  id: string; advertiser: string; channel_id: string | null;
  amount: string; currency: string; description: string | null;
  status: AdOrderStatus; liqpay_order_id: string | null; action_id: string | null;
  paid_at: Date | null; created_at: Date; updated_at: Date;
}
