import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersService } from './ad-orders.service';

function harness(order: any) {
  const calls: any[] = [];
  const repo = {
    findById: async () => order,
    setCheckout: async (id: string) => { calls.push(['setCheckout', id]); },
    attachAction: async (id: string, aid: string) => { calls.push(['attach', id, aid]); },
  } as any;
  const liqpay = { buildCheckout: (o: any) => { calls.push(['build', o]); return { data: 'D', signature: 'S', actionUrl: 'U' }; } } as any;
  const actions = { create: async (a: any) => { calls.push(['action', a]); return { id: 'act1' }; } } as any;
  return { svc: new AdOrdersService(repo, liqpay, actions), calls };
}

test('createCheckout sets liqpay_order_id=id and returns signed params', async () => {
  const { svc, calls } = harness({ id: 'o1', amount: '500.00', currency: 'UAH', description: 'Ad', status: 'draft' });
  const r = await svc.createCheckout('o1');
  assert.equal(r.data, 'D');
  assert.ok(calls.some(c => c[0] === 'setCheckout' && c[1] === 'o1'));
  const build = calls.find(c => c[0] === 'build');
  assert.equal(build[1].orderId, 'o1');
});

test('schedulePost creates a schedule_post action only when paid + attaches it', async () => {
  const { svc, calls } = harness({ id: 'o1', status: 'paid' });
  const r = await svc.schedulePost('o1', { channelId: 'c1', text: 'Ad post', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.equal(r.actionId, 'act1');
  const action = calls.find(c => c[0] === 'action');
  assert.equal(action[1].type, 'schedule_post');
  assert.equal(action[1].payload.channelId, 'c1');
  assert.ok(calls.some(c => c[0] === 'attach' && c[2] === 'act1'));
});

test('schedulePost refuses when the order is not paid', async () => {
  const { svc } = harness({ id: 'o1', status: 'awaiting_payment' });
  await assert.rejects(() => svc.schedulePost('o1', { channelId: 'c1', text: 'x', scheduledAt: '2030-01-01T00:00:00Z' }), /not paid/i);
});
