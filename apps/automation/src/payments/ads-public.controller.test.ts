import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdsPublicController } from './ads-public.controller';

function make(report: any = { stage: '24h' }) {
  const lookups: string[] = [];
  const prices = {
    list: async (o: any) => (o.activeOnly ? [{ id: 'secret-id', channel_key: '@a', format: 'post', price_uah: 900, active: true, note: null, created_at: new Date() }] : []),
    mediaKit: async () => [{ channelKey: '@a' }],
  } as any;
  const orders = { reportByToken: async (t: string) => { lookups.push(t); return report; } } as any;
  return { ctrl: new AdsPublicController(prices, orders), lookups };
}

test('GET landing/prices returns active prices without ids or timestamps', async () => {
  const { ctrl } = make();
  assert.deepEqual(await ctrl.listPrices(), [{ channelKey: '@a', format: 'post', priceUah: 900, note: null }]);
});

test('GET ads/report/:token: malformed tokens never hit the DB; unknown → 404', async () => {
  const a = make();
  await assert.rejects(() => a.ctrl.report('short'), /not found/);
  assert.equal(a.lookups.length, 0);
  const b = make(null);
  await assert.rejects(() => b.ctrl.report('A'.repeat(32)), /not found/);
  const c = make({ stage: '72h' });
  assert.deepEqual(await c.ctrl.report('A'.repeat(32)), { stage: '72h' });
});
