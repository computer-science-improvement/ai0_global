import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersController } from './ad-orders.controller';

function make() {
  const calls: any[] = [];
  const repo = { list: async (s: any) => { calls.push(['list', s]); return [{ id: 'o1' }]; },
                 create: async (i: any) => { calls.push(['create', i]); return { id: 'o1' }; } } as any;
  const svc = { createCheckout: async (id: string) => { calls.push(['checkout', id]); return { data: 'D', signature: 'S', actionUrl: 'U' }; },
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
