import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrackedChannelsConfigRepository,
  type TrackedChannelConfigRow,
  type TrackedFeaturedRow,
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

test('list() selects landing_visible and landing_order', async () => {
  const { pool, calls } = fakePool();
  const repo = new TrackedChannelsConfigRepository(pool as any);
  await repo.list();
  const sql = norm(calls[0].sql);
  assert.match(sql, /landing_visible/);
  assert.match(sql, /landing_order/);
});

test('findByChannelKey() selects landing_visible and landing_order', async () => {
  const { pool, calls } = fakePool();
  const repo = new TrackedChannelsConfigRepository(pool as any);
  await repo.findByChannelKey('k1');
  const sql = norm(calls[0].sql);
  assert.match(sql, /landing_visible/);
  assert.match(sql, /landing_order/);
});

test('landing_visible/landing_order round-trip through the row type', async () => {
  const { pool } = fakePool();
  (pool as any).__setRows([
    { id: 'c1', channel_key: 'k1', landing_visible: true, landing_order: 7 } as Partial<TrackedChannelConfigRow>,
  ]);
  const repo = new TrackedChannelsConfigRepository(pool as any);
  const rows = await repo.list();
  assert.equal(rows[0].landing_visible, true);
  assert.equal(rows[0].landing_order, 7);
});

test('setLanding issues UPDATE with [id, visible, order]', async () => {
  const { pool, calls } = fakePool();
  const repo = new TrackedChannelsConfigRepository(pool as any);
  await repo.setLanding('c1', { visible: false, order: 4 });
  const { sql, params } = calls[0];
  assert.match(sql, /UPDATE tracked_channels/);
  assert.match(norm(sql), /landing_visible\s*=\s*\$2/);
  assert.match(norm(sql), /landing_order\s*=\s*\$3/);
  assert.deepEqual(params, ['c1', false, 4]);
});

test('listFeatured selects is_mine + landing_visible, ORDER BY landing_order, projects TrackedFeaturedRow', async () => {
  const { pool, calls } = fakePool();
  (pool as any).__setRows([
    { id: 'c1', channel_key: 'k1', username: 'u1', title: 't1', subs_count: 99, landing_order: 1 },
  ]);
  const repo = new TrackedChannelsConfigRepository(pool as any);
  const rows: TrackedFeaturedRow[] = await repo.listFeatured();
  const sql = norm(calls[0].sql);
  assert.match(sql, /SELECT id, channel_key, username, title, subs_count, landing_order/);
  assert.match(sql, /FROM tracked_channels/);
  assert.match(sql, /is_mine\s*=\s*true/);
  assert.match(sql, /landing_visible\s*=\s*true/);
  assert.match(sql, /ORDER BY landing_order/);
  assert.deepEqual(rows[0], { id: 'c1', channel_key: 'k1', username: 'u1', title: 't1', subs_count: 99, landing_order: 1 });
});
