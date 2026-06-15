import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let next: any[] = [];
  const pool = {
    query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: next, rowCount: next.length }; },
    __setRows: (rows: any[]) => { next = rows; },
  };
  return { pool, calls };
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

test('setLanding issues UPDATE with [id, visible, order]', async () => {
  const { pool, calls } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any);
  await repo.setLanding('a1', { visible: true, order: 5 });
  const { sql, params } = calls[0];
  assert.match(sql, /UPDATE tiktok_accounts/);
  assert.match(norm(sql), /landing_visible\s*=\s*\$2/);
  assert.match(norm(sql), /landing_order\s*=\s*\$3/);
  assert.deepEqual(params, ['a1', true, 5]);
});

test('listFeatured selects landing_visible AND active ORDER BY landing_order, returns rows', async () => {
  const { pool, calls } = fakePool();
  (pool as any).__setRows([{ id: 'a1', landing_visible: true, landing_order: 2 }]);
  const repo = new TikTokAccountsRepository(pool as any);
  const rows = await repo.listFeatured();
  assert.deepEqual(rows, [{ id: 'a1', landing_visible: true, landing_order: 2 }]);
  const sql = norm(calls[0].sql);
  assert.match(sql, /SELECT \* FROM tiktok_accounts/);
  assert.match(sql, /WHERE landing_visible AND active/);
  assert.match(sql, /ORDER BY landing_order/);
});
