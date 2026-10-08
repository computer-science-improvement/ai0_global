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

test('GET landing/media-kit adds a mediakit DM link per channel (null without a DM account)', async () => {
  const prices = { mediaKit: async () => [{ channelKey: '@space_ua', title: 'Space UA', prices: [] }] } as any;
  const withDm = new AdsPublicController(prices, {} as any, { adDm: async () => ({ username: 'ai0_ads', template: "Hi! I'd like to order an ad in {target}. {ref}" }) });
  const [row] = await withDm.mediaKit();
  assert.match(row.adDmUrl!, /^https:\/\/t\.me\/ai0_ads\?text=/);
  assert.equal(decodeURIComponent(row.adDmUrl!.split('?text=')[1]), "Hi! I'd like to order an ad in Space UA. [ai0web:mediakit:space_ua]");
  const noDm = new AdsPublicController(prices, {} as any, { adDm: async () => null });
  assert.equal((await noDm.mediaKit())[0].adDmUrl, null);
  assert.equal((await new AdsPublicController(prices, {} as any).mediaKit())[0].adDmUrl, null);
});

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
