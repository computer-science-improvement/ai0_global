import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaFollowerHistoryRepository } from './meta-follower-history.repository';

function fakePool(rows: any[] = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const pool = { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows }; } };
  return { pool, calls };
}

test('insert writes account_id + followers with explicit casts', async () => {
  const { pool, calls } = fakePool();
  const repo = new MetaFollowerHistoryRepository(pool as any);
  await repo.insert('acct-1', 1234);
  assert.match(calls[0].sql, /INSERT INTO meta_follower_history/);
  assert.match(calls[0].sql, /\$1::uuid/);
  assert.match(calls[0].sql, /\$2::int/);
  assert.deepEqual(calls[0].params, ['acct-1', 1234]);
});

test('history orders ASC and threads from/to params (null when absent)', async () => {
  const { pool, calls } = fakePool([{ at: new Date('2026-06-01'), followers: 10 }]);
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const out = await repo.history('acct-1');
  assert.match(calls[0].sql, /ORDER BY snapshot_at ASC/);
  assert.match(calls[0].sql, /\$1::uuid/);
  assert.deepEqual(calls[0].params, ['acct-1', null, null]);
  assert.deepEqual(out, [{ at: new Date('2026-06-01'), followers: 10 }]);
});

test('latestWithDelta maps the computed row', async () => {
  const { pool } = fakePool([{ followers: 100, delta24h: 5, delta7d: 20 }]);
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const out = await repo.latestWithDelta('acct-1');
  assert.deepEqual(out, { followers: 100, delta24h: 5, delta7d: 20 });
});

test('latestWithDelta returns nulls when there is no history', async () => {
  const { pool } = fakePool([]);
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const out = await repo.latestWithDelta('acct-1');
  assert.deepEqual(out, { followers: null, delta24h: null, delta7d: null });
});
