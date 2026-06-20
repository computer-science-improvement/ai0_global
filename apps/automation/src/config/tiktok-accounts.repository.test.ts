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

// Identity secrets stub (no master key configured → plaintext passthrough).
const secretsPassthrough = { encryptIfConfigured: (v: string) => v, maybeDecrypt: (v: string) => v } as any;
// Wrapping secrets stub — proves encrypt-on-write / decrypt-on-read round-trips.
const secretsEnc = {
  encryptIfConfigured: (v: string) => `enc(${v})`,
  maybeDecrypt: (v: string) => (v.startsWith('enc(') ? v.slice(4, -1) : v),
} as any;

const TOKENS = {
  accessToken: 'AT', refreshToken: 'RT',
  accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
  refreshTokenExpiresAt: new Date('2031-01-01T00:00:00Z'),
};

test('findByOpenId returns rows[0] ?? null', async () => {
  const { pool } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any, secretsPassthrough);
  assert.equal(await repo.findByOpenId('open1'), null);
  (pool as any).__setRows([{ id: 'a1' }]);
  assert.deepEqual(await repo.findByOpenId('open1'), { id: 'a1' });
});

test('upsertFromTokens inserts with open_id, tokens, expiries, scope', async () => {
  const { pool, calls } = fakePool();
  (pool as any).__setRows([{ id: 'a1' }]);
  const repo = new TikTokAccountsRepository(pool as any, secretsPassthrough);
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
  const repo = new TikTokAccountsRepository(pool as any, secretsPassthrough);
  await repo.updateTokens('a1', TOKENS);
  const { sql, params } = calls[0];
  assert.match(sql, /UPDATE tiktok_accounts/);
  assert.match(sql, /refresh_error\s*=\s*NULL/);
  assert.match(sql, /last_refreshed_at\s*=\s*now\(\)/);
  assert.equal(params[0], 'a1');
});

test('encrypts tokens on write when a key is configured', async () => {
  const { pool, calls } = fakePool();
  (pool as any).__setRows([{ id: 'a1', access_token: 'enc(AT)', refresh_token: 'enc(RT)' }]);
  const repo = new TikTokAccountsRepository(pool as any, secretsEnc);
  const row = await repo.upsertFromTokens({ ...TOKENS, openId: 'open1', scope: null });
  // Stored ciphertext, never plaintext:
  assert.ok(calls[0].params.includes('enc(AT)'));
  assert.ok(calls[0].params.includes('enc(RT)'));
  assert.ok(!calls[0].params.includes('AT'));
  // Caller still gets plaintext back (decode on read):
  assert.equal(row.access_token, 'AT');
  assert.equal(row.refresh_token, 'RT');
});

test('decrypts tokens on read; legacy plaintext rows pass through', async () => {
  const { pool } = fakePool();
  (pool as any).__setRows([{ id: 'a1', access_token: 'enc(AT)', refresh_token: 'plainRT' }]);
  const repo = new TikTokAccountsRepository(pool as any, secretsEnc);
  const row = await repo.findById('a1');
  assert.equal(row!.access_token, 'AT');     // decrypted
  assert.equal(row!.refresh_token, 'plainRT'); // legacy plaintext untouched
});

test('setRefreshError and setActive issue the right params', async () => {
  const { pool, calls } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any, secretsPassthrough);
  await repo.setRefreshError('a1', 'boom');
  assert.deepEqual(calls[0].params, ['a1', 'boom']);
  await repo.setActive('a1', false);
  assert.deepEqual(calls[1].params, ['a1', false]);
});
