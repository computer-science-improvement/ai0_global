import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyBindingsRepository } from './strategy-bindings.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [{ id: 'b1' }], rowCount: 1 }; } };
  return { pool, calls };
}

test('insert writes tiktok_account_id and selects it back', async () => {
  const { pool, calls } = fakePool();
  const repo = new StrategyBindingsRepository(pool as any);
  await repo.insert({
    ext_id: 'recipe-carousel:tt', type: 'recipe-carousel', schedule: '0 * * * *',
    params: {}, platform: 'tiktok', tiktok_account_id: 'tt-acc-1',
  });
  const { sql, params } = calls[0];
  assert.match(sql, /tiktok_account_id/);
  assert.ok(params.includes('tt-acc-1'));
});

test('list selects tiktok_account_id', async () => {
  const { pool, calls } = fakePool();
  const repo = new StrategyBindingsRepository(pool as any);
  await repo.list();
  assert.match(calls[0].sql, /tiktok_account_id/);
});
