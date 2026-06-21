import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiqpayService } from './liqpay.service';
import { decodeData, sign } from './liqpay.util';

const cfg = (env: Record<string, string | undefined>) => ({ get: (k: string) => env[k] }) as any;
const KEYS = { LIQPAY_PUBLIC_KEY: 'pub', LIQPAY_PRIVATE_KEY: 'priv', DASHBOARD_URL: 'https://x' };

test('buildCheckout encodes order params and signs them', () => {
  const svc = new LiqpayService(cfg(KEYS));
  const r = svc.buildCheckout({ orderId: 'o1', amount: '500.00', currency: 'UAH', description: 'Ad' });
  const params = decodeData(r.data);
  assert.equal(params.order_id, 'o1');
  assert.equal(params.amount, '500.00');
  assert.equal(params.public_key, 'pub');
  assert.equal(r.signature, sign(r.data, 'priv'));
  assert.match(r.actionUrl, /liqpay\.ua/);
});

test('buildCheckout throws a clear error when keys unset', () => {
  const svc = new LiqpayService(cfg({}));
  assert.throws(() => svc.buildCheckout({ orderId: 'o1', amount: '1', currency: 'UAH', description: '' }), /not configured/i);
});

test('verifyCallback returns {valid,status,orderId} for a self-signed payload', () => {
  const svc = new LiqpayService(cfg(KEYS));
  const data = Buffer.from(JSON.stringify({ order_id: 'o1', status: 'success' })).toString('base64');
  const signature = sign(data, 'priv');
  assert.deepEqual(svc.verifyCallback(data, signature), { valid: true, status: 'success', orderId: 'o1' });
});

test('verifyCallback rejects a bad signature', () => {
  const svc = new LiqpayService(cfg(KEYS));
  const data = Buffer.from(JSON.stringify({ order_id: 'o1', status: 'success' })).toString('base64');
  assert.deepEqual(svc.verifyCallback(data, 'bad'), { valid: false });
});
