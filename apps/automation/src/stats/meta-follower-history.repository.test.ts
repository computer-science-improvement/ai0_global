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

test('history forwards concrete from/to dates as params', async () => {
  const { pool, calls } = fakePool([]);
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const from = new Date('2026-06-01T00:00:00Z');
  const to   = new Date('2026-06-10T00:00:00Z');
  await repo.history('acct-1', from, to);
  assert.deepEqual(calls[0].params, ['acct-1', from, to]);
});

test('insert is idempotent on the (account_id, snapshot_at) key', async () => {
  const { pool, calls } = fakePool();
  const repo = new MetaFollowerHistoryRepository(pool as any);
  await repo.insert('acct-1', 1);
  assert.match(calls[0].sql, /ON CONFLICT DO NOTHING/);
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

test('delta24hByAccount maps account_id → delta', async () => {
  const pool = { query: async (_sql: string) => ({ rows: [
    { account_id: 'a1', delta24h: 12 },
    { account_id: 'a2', delta24h: null },
  ] }) };
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const m = await repo.delta24hByAccount();
  assert.equal(m.get('a1'), 12);
  assert.equal(m.get('a2'), null);
  assert.equal(m.get('missing'), undefined);
});
