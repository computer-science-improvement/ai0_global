import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyBindingsRepository } from './strategy-bindings.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [{ id: 'b1' }], rowCount: 1 }; } };
  return { pool, calls };
}

test('update(id, { ext_id }) sets ext_id and binds the value', async () => {
  const { pool, calls } = fakePool();
  const repo = new StrategyBindingsRepository(pool as any);
  await repo.update('b1', { ext_id: 'renamed:slug' } as any);
  const { sql, params } = calls[0];
  assert.match(sql, /SET[\s\S]*ext_id\s*=/);
  assert.ok(params.includes('renamed:slug'));
  assert.ok(params.includes('b1'));
});
