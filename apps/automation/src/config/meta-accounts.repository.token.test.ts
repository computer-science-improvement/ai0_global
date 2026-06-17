import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountsRepository } from './meta-accounts.repository';

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

test('setTokenMeta issues UPDATE persisting type/expiry/scopes/checked_at', async () => {
  const { pool, calls } = fakePool();
  const repo = new MetaAccountsRepository(pool as any);
  const expiresAt = new Date(1786884952 * 1000);
  const dataAccessExpiresAt = new Date(1789476951 * 1000);
  await repo.setTokenMeta('a1', {
    type: 'PAGE', expiresAt, dataAccessExpiresAt,
    scopes: ['pages_manage_posts'], isValid: true,
  });
  const { sql, params } = calls[0];
  assert.match(norm(sql), /UPDATE meta_accounts/);
  assert.match(norm(sql), /token_type\s*=\s*\$2/);
  assert.match(norm(sql), /token_expires_at\s*=\s*\$3/);
  assert.match(norm(sql), /token_data_access_expires_at\s*=\s*\$4/);
  assert.match(norm(sql), /token_scopes\s*=\s*\$5/);
  assert.match(norm(sql), /token_valid\s*=\s*\$6/);
  assert.match(norm(sql), /token_checked_at\s*=\s*now\(\)/);
  assert.match(norm(sql), /WHERE id\s*=\s*\$1/);
  // isValid IS persisted now (token_valid = $6); id + type/expiry/dataExpiry/scopes/valid
  assert.deepEqual(params, ['a1', 'PAGE', expiresAt, dataAccessExpiresAt, ['pages_manage_posts'], true]);
});

test('setTokenMeta passes null expiries through (never-expires token)', async () => {
  const { pool, calls } = fakePool();
  const repo = new MetaAccountsRepository(pool as any);
  await repo.setTokenMeta('a2', {
    type: 'SYSTEM_USER', expiresAt: null, dataAccessExpiresAt: null,
    scopes: [], isValid: true,
  });
  assert.deepEqual(calls[0].params, ['a2', 'SYSTEM_USER', null, null, [], true]);
});

test('setTokenMeta persists token_valid = false for an invalid token', async () => {
  const { pool, calls } = fakePool();
  const repo = new MetaAccountsRepository(pool as any);
  await repo.setTokenMeta('a3', {
    type: null, expiresAt: null, dataAccessExpiresAt: null,
    scopes: [], isValid: false,
  });
  assert.deepEqual(calls[0].params, ['a3', null, null, null, [], false]);
});

test('token_* columns round-trip through the row type (SELECT *)', async () => {
  const { pool } = fakePool();
  const row = {
    id: 'a1', platform: 'facebook', account_id: 'acc', token_env: 'FB_TOKEN', target_id: 't1',
    token_type: 'PAGE', token_expires_at: new Date(), token_data_access_expires_at: null,
    token_scopes: ['pages_manage_posts'], token_valid: false, token_checked_at: new Date(),
  };
  (pool as any).__setRows([row]);
  const repo = new MetaAccountsRepository(pool as any);
  const got = await repo.findById('a1');
  assert.equal(got!.token_type, 'PAGE');
  assert.deepEqual(got!.token_scopes, ['pages_manage_posts']);
  assert.equal(got!.token_data_access_expires_at, null);
  assert.equal(got!.token_valid, false);
});
