import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountsController } from './meta-accounts.controller';
import { SecretsService } from '../../common/crypto/secrets.service';

// No master key → resolveToken falls back to the env path (token_enc null).
const secrets = () => new SecretsService({ get: () => undefined } as any);

function make(over: any = {}) {
  const setTokenMetaCalls: any[] = [];
  const accounts = {
    findById: async (id: string) => over.account ?? { id, platform: over.platform ?? 'facebook', target_id: 't1', token_env: 'META_TOKEN', token_enc: null },
    list: async () => over.accountsList ?? [],
    markVerified: async () => {},
    markVerifyError: async () => {},
    setTokenMeta: async (id: string, info: any) => { setTokenMetaCalls.push({ id, info }); },
  };
  const graph = {
    verify: over.verify ?? (async () => ({ username: 'u', displayName: 'U', followers: 1, pictureUrl: null })),
    inspectToken: over.inspectToken ?? (async () => null),
  };
  const env = { get: () => over.token ?? 'tok' };
  const history = { delta24hByAccount: async () => new Map() };
  const insights = {};
  const collector = {};
  const bindings = { listByMetaAccount: async () => [], deleteByMetaAccount: async () => 0 };
  const publisher = { publish: async () => {} };
  const c = new MetaAccountsController(accounts as any, graph as any, env as any, history as any, insights as any, collector as any, bindings as any, publisher as any, secrets());
  return { c, setTokenMetaCalls };
}

test('verify persists token meta when inspectToken returns info (facebook)', async () => {
  let inspectCalled = 0;
  const info = { type: 'PAGE', expiresAt: new Date(), dataAccessExpiresAt: null, scopes: ['pages_manage_posts'], isValid: true };
  const { c, setTokenMetaCalls } = make({
    platform: 'facebook',
    inspectToken: async () => { inspectCalled++; return info; },
  });
  const out = await c.verify('a1') as any;
  assert.equal(out.ok, true);
  assert.equal(inspectCalled, 1);
  assert.equal(setTokenMetaCalls.length, 1);
  assert.deepEqual(setTokenMetaCalls[0].info, info);
});

test('verify captures token meta even when graph.verify THROWS (non-threads)', async () => {
  let inspectCalled = 0;
  const info = { type: 'PAGE', expiresAt: null, dataAccessExpiresAt: null, scopes: ['pages_manage_posts'], isValid: false };
  const { c, setTokenMetaCalls } = make({
    platform: 'facebook',
    verify: async () => { throw new Error('Unsupported get request. Object with ID does not exist'); },
    inspectToken: async () => { inspectCalled++; return info; },
  });
  const out = await c.verify('a1') as any;
  // verify failed → ok:false with the error, but token meta was still saved
  assert.equal(out.ok, false);
  assert.match(out.error, /Unsupported get request/);
  assert.equal(inspectCalled, 1);
  assert.equal(setTokenMetaCalls.length, 1);
  assert.deepEqual(setTokenMetaCalls[0].info, info);
});

test('verify still ok when inspectToken returns null (best-effort)', async () => {
  const { c, setTokenMetaCalls } = make({ platform: 'instagram', inspectToken: async () => null });
  const out = await c.verify('a1') as any;
  assert.equal(out.ok, true);
  assert.equal(setTokenMetaCalls.length, 0);
});

test('verify does NOT inspect token for threads accounts', async () => {
  let inspectCalled = 0;
  const { c, setTokenMetaCalls } = make({
    platform: 'threads',
    inspectToken: async () => { inspectCalled++; return { type: 'USER', expiresAt: null, dataAccessExpiresAt: null, scopes: [], isValid: true }; },
  });
  const out = await c.verify('a1') as any;
  assert.equal(out.ok, true);
  assert.equal(inspectCalled, 0);
  assert.equal(setTokenMetaCalls.length, 0);
});

test('list projection includes token_* fields but never a token value', async () => {
  const row = {
    id: 'acc-1', platform: 'facebook', account_id: 'fb', token_env: 'FB_TOKEN', target_id: 't',
    username: 'u', display_name: 'U', followers: 100, picture_url: null,
    active: true, last_verified_at: null, verify_error: null, created_at: new Date(),
    token_type: 'PAGE', token_expires_at: new Date('2026-08-01T00:00:00Z'),
    token_data_access_expires_at: null, token_scopes: ['pages_manage_posts'],
    token_valid: false, token_checked_at: new Date('2026-06-17T00:00:00Z'),
  };
  const { c } = make({ accountsList: [row] });
  const out = await c.list() as any[];
  assert.equal(out[0].token_type, 'PAGE');
  assert.deepEqual(out[0].token_scopes, ['pages_manage_posts']);
  assert.ok(out[0].token_expires_at instanceof Date);
  assert.ok(out[0].token_checked_at instanceof Date);
  assert.equal(out[0].token_data_access_expires_at, null);
  assert.equal(out[0].token_valid, false);
  // no raw token field of any kind
  assert.equal('token' in out[0], false);
  assert.equal('access_token' in out[0], false);
});
