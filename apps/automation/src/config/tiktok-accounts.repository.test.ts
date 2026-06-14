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

const TOKENS = {
  accessToken: 'AT', refreshToken: 'RT',
  accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
  refreshTokenExpiresAt: new Date('2031-01-01T00:00:00Z'),
};

test('findByOpenId returns rows[0] ?? null', async () => {
  const { pool } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any);
  assert.equal(await repo.findByOpenId('open1'), null);
  (pool as any).__setRows([{ id: 'a1' }]);
  assert.deepEqual(await repo.findByOpenId('open1'), { id: 'a1' });
});

test('upsertFromTokens inserts with open_id, tokens, expiries, scope', async () => {
  const { pool, calls } = fakePool();
  (pool as any).__setRows([{ id: 'a1' }]);
  const repo = new TikTokAccountsRepository(pool as any);
  const row = await repo.upsertFromTokens({ ...TOKENS, openId: 'open1', scope: 'user.info.basic,video.publish' });
  assert.deepEqual(row, { id: 'a1' });
  const { sql, params } = calls[0];
  assert.match(sql, /INSERT INTO tiktok_accounts/);
  assert.match(sql, /ON CONFLICT \(open_id\) DO UPDATE/);
  assert.equal(params[0], 'open1');
  assert.ok(params.includes('AT'));
  assert.ok(params.includes('RT'));
});

test('updateTokens sets tokens + clears refresh_error', async () => {
  const { pool, calls } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any);
  await repo.updateTokens('a1', TOKENS);
  const { sql, params } = calls[0];
  assert.match(sql, /UPDATE tiktok_accounts/);
  assert.match(sql, /refresh_error\s*=\s*NULL/);
  assert.match(sql, /last_refreshed_at\s*=\s*now\(\)/);
  assert.equal(params[0], 'a1');
});

test('setRefreshError and setActive issue the right params', async () => {
  const { pool, calls } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any);
  await repo.setRefreshError('a1', 'boom');
  assert.deepEqual(calls[0].params, ['a1', 'boom']);
  await repo.setActive('a1', false);
  assert.deepEqual(calls[1].params, ['a1', false]);
});
