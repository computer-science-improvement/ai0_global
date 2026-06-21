import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersRepository } from './ad-orders.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; },
    pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any };
}

test('create inserts advertiser/amount/currency and returns the row', async () => {
  const { pool, calls, setRows } = fakePool();
  setRows([{ id: 'o1' }]);
  const repo = new AdOrdersRepository(pool);
  const r = await repo.create({ advertiser: 'Acme', channelId: 'c1', amount: '500.00', currency: 'UAH', description: 'Ad' });
  assert.match(calls[0].sql, /INSERT INTO ad_orders/);
  assert.equal(calls[0].params[0], 'Acme');
  assert.equal(r.id, 'o1');
});

test('setCheckout sets liqpay_order_id + awaiting_payment', async () => {
  const { pool, calls } = fakePool();
  const repo = new AdOrdersRepository(pool);
  await repo.setCheckout('o1');
  assert.match(calls[0].sql, /status = 'awaiting_payment'/);
  assert.match(calls[0].sql, /liqpay_order_id = \$1/);
  assert.deepEqual(calls[0].params, ['o1']);
});

test('markPaid only flips non-paid orders (idempotent)', async () => {
  const { pool, calls } = fakePool();
  const repo = new AdOrdersRepository(pool);
  await repo.markPaid('o1');
  assert.match(calls[0].sql, /SET status = 'paid'/);
  assert.match(calls[0].sql, /status IN \('awaiting_payment','draft'\)/);
  assert.deepEqual(calls[0].params, ['o1']);
});

test('list filters by status', async () => {
  const { pool, calls } = fakePool();
  const repo = new AdOrdersRepository(pool);
  await repo.list('paid');
  assert.match(calls[0].sql, /status = \$1/);
  assert.deepEqual(calls[0].params, ['paid']);
});
