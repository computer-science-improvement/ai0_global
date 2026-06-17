import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyBindingsRepository } from './strategy-bindings.repository';

function fakePool(result: any = { rows: [], rowCount: 0 }) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return result; } };
  return { pool, calls };
}

test('listByMetaAccount filters by meta_account_id and maps rows', async () => {
  const rows = [{ id: 'b1', ext_id: 'recipes:ig', type: 'recipe-carousel', meta_account_id: 'acc-1' }];
  const { pool, calls } = fakePool({ rows, rowCount: rows.length });
  const repo = new StrategyBindingsRepository(pool as any);
  const out = await repo.listByMetaAccount('acc-1');
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /SELECT[\s\S]*FROM\s+strategy_bindings/i);
  assert.match(sql, /WHERE\s+meta_account_id\s*=\s*\$1/i);
  assert.deepEqual(params, ['acc-1']);
  assert.deepEqual(out, rows);
});

test('deleteByMetaAccount issues DELETE filtered by meta_account_id and returns rowCount', async () => {
  const { pool, calls } = fakePool({ rows: [], rowCount: 3 });
  const repo = new StrategyBindingsRepository(pool as any);
  const n = await repo.deleteByMetaAccount('acc-1');
  assert.equal(n, 3);
  const { sql, params } = calls[0];
  assert.match(sql, /DELETE\s+FROM\s+strategy_bindings/i);
  assert.match(sql, /WHERE\s+meta_account_id\s*=\s*\$1/i);
  assert.deepEqual(params, ['acc-1']);
});

test('deleteByMetaAccount returns 0 when rowCount is null', async () => {
  const { pool } = fakePool({ rows: [], rowCount: null });
  const repo = new StrategyBindingsRepository(pool as any);
  const n = await repo.deleteByMetaAccount('acc-1');
  assert.equal(n, 0);
});
