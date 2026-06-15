import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';

function fakePool(rowCount: number) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [], rowCount }; } };
  return { pool, calls };
}

test('delete issues DELETE with the id and returns true when a row was removed', async () => {
  const { pool, calls } = fakePool(1);
  const repo = new TikTokAccountsRepository(pool as any);
  assert.equal(await repo.delete('a1'), true);
  assert.match(calls[0].sql, /DELETE FROM tiktok_accounts WHERE id = \$1/);
  assert.deepEqual(calls[0].params, ['a1']);
});

test('delete returns false when no row matched', async () => {
  const { pool } = fakePool(0);
  const repo = new TikTokAccountsRepository(pool as any);
  assert.equal(await repo.delete('missing'), false);
});
