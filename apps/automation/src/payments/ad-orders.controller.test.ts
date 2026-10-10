import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersController, AdPricesController } from './ad-orders.controller';

function make() {
  const calls: any[] = [];
  const repo = { list: async (s: any) => { calls.push(['list', s]); return [{ id: 'o1' }]; },
                 create: async (i: any) => { calls.push(['create', i]); return { id: 'o1' }; } } as any;
  const svc = { create: async (i: any) => { calls.push(['create', i]); return { id: 'o1' }; },
                update: async (id: string, i: any) => { calls.push(['update', id, i]); return { id }; },
                createCheckout: async (id: string) => { calls.push(['checkout', id]); return { data: 'D', signature: 'S', actionUrl: 'U' }; },
                schedulePost: async (id: string, i: any) => { calls.push(['schedule', id, i]); return { actionId: 'a1' }; } } as any;
  return { ctrl: new AdOrdersController(repo, svc), calls };
}

test('GET lists orders by status', async () => {
  const { ctrl, calls } = make();
  const r = await ctrl.list('paid');
  assert.deepEqual(calls[0], ['list', 'paid']);
  assert.equal(r.length, 1);
});
test('POST create passes the dto through', async () => {
  const { ctrl, calls } = make();
  await ctrl.create({ advertiser: 'Acme', amount: '500.00', currency: 'UAH' } as any);
  assert.equal(calls[0][0], 'create');
});
test('POST checkout returns signed params', async () => {
  const { ctrl } = make();
  const r = await ctrl.checkout('o1');
  assert.equal(r.data, 'D');
});
test('POST schedule calls service', async () => {
  const { ctrl, calls } = make();
  const r = await ctrl.schedule('o1', { channelId: 'c1', text: 'x', scheduledAt: '2030-01-01T00:00:00Z' } as any);
  assert.equal(r.actionId, 'a1');
});
test('PATCH update goes through the service (creative validation lives there)', async () => {
  const { ctrl, calls } = make();
  await ctrl.update('o1', { sponsorLabel: 'ФОП' } as any);
  assert.deepEqual(calls[0], ['update', 'o1', { sponsorLabel: 'ФОП' }]);
});

test('spec 036: PUT price refuses a digest_sponsor price where no digest strategy runs; other formats pass', async () => {
  const saved: any[] = [];
  const prices = { upsertActive: async (i: any) => { saved.push(i); return { id: 'p1', ...i }; } } as any;
  const ctrl = new AdPricesController(prices, { digestRunsOn: async (k: string) => k === '@digest_on' } as any);
  await assert.rejects(() => ctrl.upsert({ channelKey: 'agent_run', format: 'digest_sponsor', priceUah: 400 } as any), /digest_sponsor is not sold on @agent_run/);
  await ctrl.upsert({ channelKey: 'digest_on', format: 'digest_sponsor', priceUah: 400 } as any);
  await ctrl.upsert({ channelKey: 'agent_run', format: 'post', priceUah: 900 } as any);
  assert.deepEqual(saved.map((s) => [s.channelKey, s.format]), [['@digest_on', 'digest_sponsor'], ['@agent_run', 'post']]);
});
