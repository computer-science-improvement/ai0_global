import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersService } from './ad-orders.service';

function harness(order: any, price: any = null) {
  const calls: any[] = [];
  const repo = {
    findById: async () => order,
    setCheckout: async (id: string) => { calls.push(['setCheckout', id]); },
    attachAction: async (id: string, aid: string) => { calls.push(['attach', id, aid]); },
    create: async (i: any) => { calls.push(['create', i]); return { id: 'new', ...i }; },
    update: async (id: string, p: any) => { calls.push(['update', id, p]); return order ? { ...order, ...p } : null; },
  } as any;
  const liqpay = { buildCheckout: (o: any) => { calls.push(['build', o]); return { data: 'D', signature: 'S', actionUrl: 'U' }; } } as any;
  const actions = { create: async (a: any) => { calls.push(['action', a]); return { id: 'act1' }; } } as any;
  const prices = { findById: async () => price } as any;
  return { svc: new AdOrdersService(repo, liqpay, actions, prices), calls };
}

const CREATIVE = { format: 'text', body: [{ type: 'p', text: 'Курси англійської для дорослих.' }] };

test('createCheckout sets liqpay_order_id=id and returns signed params', async () => {
  const { svc, calls } = harness({ id: 'o1', amount: '500.00', currency: 'UAH', description: 'Ad', status: 'draft' });
  const r = await svc.createCheckout('o1');
  assert.equal(r.data, 'D');
  assert.ok(calls.some(c => c[0] === 'setCheckout' && c[1] === 'o1'));
  const build = calls.find(c => c[0] === 'build');
  assert.equal(build[1].orderId, 'o1');
});

test('create with priceId: amount and channel come from the active price, not the client', async () => {
  const { svc, calls } = harness(null, { id: 'pr1', channel_key: '@space_ua', format: 'post', price_uah: 1500, active: true });
  await svc.create({ advertiser: 'Acme', priceId: 'pr1', amount: '1.00', currency: 'USD' });
  const c = calls.find(x => x[0] === 'create')[1];
  assert.equal(c.amount, '1500.00');
  assert.equal(c.currency, 'UAH');
  assert.equal(c.priceId, 'pr1');
  assert.equal(c.channelId, '@space_ua');
});

test('create refuses an inactive price and a missing amount without price', async () => {
  const a = harness(null, { id: 'pr1', channel_key: '@x', format: 'post', price_uah: 10, active: false });
  await assert.rejects(() => a.svc.create({ advertiser: 'Acme', priceId: 'pr1' }), /inactive/);
  const b = harness(null);
  await assert.rejects(() => b.svc.create({ advertiser: 'Acme' }), /amount is required/);
});

test('create validates the creative against the sponsored subset (no hashtags)', async () => {
  const { svc } = harness(null);
  await assert.rejects(() => svc.create({ advertiser: 'A', amount: '10', creative: { ...CREATIVE, hashtags: ['x'] } }), /invalid creative/);
  await svc.create({ advertiser: 'A', amount: '10', creative: CREATIVE });
});

test('schedulePost (legacy text) creates a schedule_post action with orderId and a #реклама preview', async () => {
  const { svc, calls } = harness({ id: 'o1', status: 'paid', advertiser: 'Acme', creative: null, sponsor_label: null, thread_id: null, publish_at: null });
  const r = await svc.schedulePost('o1', { channelId: 'c1', text: 'Ad post', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.equal(r.actionId, 'act1');
  const action = calls.find(c => c[0] === 'action')[1];
  assert.equal(action.type, 'schedule_post');
  assert.equal(action.payload.channelId, 'c1');
  assert.equal(action.payload.orderId, 'o1');
  assert.equal(action.payload.scheduledAt, '2030-01-01T00:00:00.000Z');
  assert.match(action.payload.text, /Ad post\n\n#реклама$/);
  const upd = calls.find(c => c[0] === 'update');
  assert.equal(upd[2].creative.body[0].text, 'Ad post', 'the legacy text is stored as the order creative');
  assert.ok(calls.some(c => c[0] === 'attach' && c[2] === 'act1'));
});

test('schedulePost uses the order creative, channel and publish_at when the request omits them', async () => {
  const { svc, calls } = harness({ id: 'o1', status: 'paid', advertiser: 'Acme', creative: CREATIVE, sponsor_label: 'ФОП Коваль', channel_id: 'c9', publish_at: new Date('2030-02-02T10:00:00Z'), thread_id: 't1' });
  await svc.schedulePost('o1', {});
  const action = calls.find(c => c[0] === 'action')[1];
  assert.equal(action.payload.channelId, 'c9');
  assert.equal(action.payload.scheduledAt, '2030-02-02T10:00:00.000Z');
  assert.match(action.payload.text, /Реклама\. Замовник: ФОП Коваль\n#реклама$/);
  assert.equal(action.threadId, 't1');
});

test('schedulePost refuses when the order is not paid, or has nothing to publish', async () => {
  const a = harness({ id: 'o1', status: 'awaiting_payment' });
  await assert.rejects(() => a.svc.schedulePost('o1', { channelId: 'c1', text: 'x', scheduledAt: '2030-01-01T00:00:00Z' }), /not paid/i);
  const b = harness({ id: 'o1', status: 'paid', creative: null, publish_at: null });
  await assert.rejects(() => b.svc.schedulePost('o1', { channelId: 'c1', scheduledAt: '2030-01-01T00:00:00Z' }), /no creative/);
  const c = harness({ id: 'o1', status: 'paid', creative: CREATIVE, publish_at: null });
  await assert.rejects(() => c.svc.schedulePost('o1', { channelId: 'c1' }), /scheduledAt is required/);
});
