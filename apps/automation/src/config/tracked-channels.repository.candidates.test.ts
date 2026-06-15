import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrackedChannelsConfigRepository,
  type TrackedCandidateRow,
} from './tracked-channels.repository';

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

test('listLandingCandidates selects subs_count + landing flags, is_mine=true, ORDER BY landing_order, added_at', async () => {
  const { pool, calls } = fakePool();
  (pool as any).__setRows([
    { id: 'c1', channel_key: 'k1', username: 'u1', title: 't1', subs_count: 99, landing_visible: false, landing_order: 2 },
  ]);
  const repo = new TrackedChannelsConfigRepository(pool as any);
  const rows: TrackedCandidateRow[] = await repo.listLandingCandidates();
  const sql = norm(calls[0].sql);
  assert.match(sql, /SELECT id, channel_key, username, title, subs_count, landing_visible, landing_order/);
  assert.match(sql, /FROM tracked_channels/);
  assert.match(sql, /is_mine\s*=\s*true/);
  assert.match(sql, /ORDER BY landing_order, added_at/);
  // includes non-visible candidates
  assert.deepEqual(rows[0], {
    id: 'c1', channel_key: 'k1', username: 'u1', title: 't1', subs_count: 99, landing_visible: false, landing_order: 2,
  });
});
