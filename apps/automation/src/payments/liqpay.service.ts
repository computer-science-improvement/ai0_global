import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign, encodeData, decodeData, verify } from './liqpay.util';

const CHECKOUT_URL = 'https://www.liqpay.ua/api/3/checkout';

@Injectable()
export class LiqpayService {
  constructor(private readonly config: ConfigService) {}

  private keys(): { pub: string; priv: string } {
    const pub = this.config.get<string>('LIQPAY_PUBLIC_KEY');
    const priv = this.config.get<string>('LIQPAY_PRIVATE_KEY');
    if (!pub || !priv) throw new Error('LiqPay not configured (LIQPAY_PUBLIC_KEY/LIQPAY_PRIVATE_KEY)');
    return { pub, priv };
  }

  buildCheckout(o: { orderId: string; amount: string; currency: string; description: string }): { data: string; signature: string; actionUrl: string } {
    const { pub, priv } = this.keys();
    const base = this.config.get<string>('DASHBOARD_URL') ?? '';
    const params = {
      public_key:  pub,
      version:     3,
      action:      'pay',
      amount:      o.amount,
      currency:    o.currency,
      description: o.description,
      order_id:    o.orderId,
      server_url:  base ? `${base}/api/payments/liqpay/callback` : undefined,
    };
    const data = encodeData(params);
    return { data, signature: sign(data, priv), actionUrl: CHECKOUT_URL };
  }

  verifyCallback(data: string, signature: string): { valid: boolean; status?: string; orderId?: string } {
    let priv: string;
    try { priv = this.keys().priv; } catch { return { valid: false }; }
    if (!verify(data, signature, priv)) return { valid: false };
    try {
      const p = decodeData<{ status?: string; order_id?: string }>(data);
      return { valid: true, status: p.status, orderId: p.order_id };
    } catch { return { valid: false }; }
  }
}
