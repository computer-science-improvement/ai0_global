import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountsController } from './meta-accounts.controller';
import { SecretsService } from '../../common/crypto/secrets.service';

// No master key → resolveToken falls back to the env path (token_enc null).
const secrets = () => new SecretsService({ get: () => undefined } as any);

// Master key set → encrypt works (Part 1/2 write path).
const MASTER = 'a'.repeat(64);
const encSecrets = () => new SecretsService({ get: (k: string) => (k === 'TOKEN_ENCRYPTION_KEY' ? MASTER : undefined) } as any);

function make(over: any = {}) {
  const setTokenMetaCalls: any[] = [];
  const setTokenEncCalls: any[] = [];
  const insertCalls: any[] = [];
  const accounts = {
    findById: async (id: string) => over.account ?? { id, platform: over.platform ?? 'facebook', target_id: 't1', token_env: 'META_TOKEN', token_enc: null },
    findByPlatformAccount: async () => over.existing ?? null,
    insert: async (input: any) => { insertCalls.push(input); return { id: 'new-1', ...input, username: null, display_name: null, followers: null, picture_url: null, active: true, last_verified_at: null, verify_error: null, created_at: new Date(), token_type: null, token_expires_at: null, token_data_access_expires_at: null, token_scopes: null, token_valid: null, token_checked_at: null }; },
    list: async () => over.accountsList ?? [],
    markVerified: async () => {},
    markVerifyError: async () => {},
    setTokenEnc: async (id: string, enc: string | null) => { setTokenEncCalls.push({ id, enc }); },
    setTokenMeta: async (id: string, info: any) => { setTokenMetaCalls.push({ id, info }); },
  };
  const graph = {
    verify: over.verify ?? (async () => ({ username: 'u', displayName: 'U', followers: 1, pictureUrl: null })),
    inspectToken: over.inspectToken ?? (async () => null),
    refreshThreadsToken: over.refreshThreadsToken ?? (async () => ({ accessToken: 'NEW_TOKEN', expiresInSec: 5_184_000 })),
  };
  // 'token' in over → use that value verbatim (including undefined); else 'tok'.
  const env = { get: () => ('token' in over ? over.token : 'tok') };
  const history = { delta24hByAccount: async () => new Map() };
  const insights = {};
  const collector = {};
  const bindings = { listByMetaAccount: async () => [], deleteByMetaAccount: async () => 0 };
  const publisher = { publish: async () => {} };
  const sec = over.secrets ?? secrets();
  const c = new MetaAccountsController(accounts as any, graph as any, env as any, history as any, insights as any, collector as any, bindings as any, publisher as any, sec);
  return { c, setTokenMetaCalls, setTokenEncCalls, insertCalls };
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

// ── Part 1: create with a token VALUE encrypts into token_enc ─────────────────

test('create with token value encrypts it into token_enc and never echoes it', async () => {
  const sec = encSecrets();
  const { c, insertCalls } = make({ secrets: sec });
  const out = await c.create({ platform: 'facebook', accountId: 'fb', targetId: 't1', token: '  RAW_TOKEN  ' } as any) as any;
  assert.equal(insertCalls.length, 1);
  // token_env is null on the value path; token_enc is an enc:v1 blob of the trimmed token.
  assert.equal(insertCalls[0].token_env, null);
  assert.ok(insertCalls[0].token_enc.startsWith('enc:v1:'), 'token_enc must be an encrypted blob');
  assert.equal(sec.decrypt(insertCalls[0].token_enc), 'RAW_TOKEN', 'token is trimmed then encrypted');
  // Response leaks neither the plaintext nor the encrypted blob.
  assert.equal('token' in out, false);
  assert.equal('token_enc' in out, false);
  assert.equal('access_token' in out, false);
});

test('create with only tokenEnv keeps the legacy env path (no token_enc)', async () => {
  const { c, insertCalls } = make({ secrets: encSecrets() });
  const out = await c.create({ platform: 'facebook', accountId: 'fb', targetId: 't1', tokenEnv: 'FB_TOKEN' } as any) as any;
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].token_env, 'FB_TOKEN');
  assert.equal(insertCalls[0].token_enc, null);
  assert.equal('token_enc' in out, false);
});

test('create with neither token nor tokenEnv → 400', async () => {
  const { c } = make({ secrets: encSecrets() });
  await assert.rejects(
    () => c.create({ platform: 'facebook', accountId: 'fb', targetId: 't1' } as any),
    /token value or an env var name/,
  );
});

// ── Part 2: Threads token refresh ─────────────────────────────────────────────

test('refresh-threads-token on a non-threads account → 400', async () => {
  const { c } = make({ account: { id: 'a1', platform: 'facebook', token_env: 'X', token_enc: null } });
  await assert.rejects(() => c.refreshThreadsToken('a1'), /only valid for threads/);
});

test('refresh-threads-token with no token to refresh → 400', async () => {
  // threads account, env path, but env var resolves to undefined.
  const { c } = make({
    account: { id: 'a1', platform: 'threads', token_env: 'MISSING', token_enc: null },
    token: undefined,
  });
  await assert.rejects(() => c.refreshThreadsToken('a1'), /no token to refresh/);
});

test('refresh-threads-token happy path: refresh → encrypt → setTokenEnc + setTokenMeta, no leak', async () => {
  const sec = encSecrets();
  let refreshArg: string | undefined;
  const { c, setTokenEncCalls, setTokenMetaCalls } = make({
    secrets: sec,
    account: { id: 'a1', platform: 'threads', token_env: 'THREADS_TOKEN', token_enc: null },
    token: 'CURRENT_TOKEN',
    refreshThreadsToken: async (t: string) => { refreshArg = t; return { accessToken: 'FRESH_TOKEN', expiresInSec: 5_184_000 }; },
  });
  const out = await c.refreshThreadsToken('a1') as any;

  assert.equal(refreshArg, 'CURRENT_TOKEN', 'refresh is called with the resolved current token');
  // New token is encrypted + persisted via setTokenEnc.
  assert.equal(setTokenEncCalls.length, 1);
  assert.ok(setTokenEncCalls[0].enc.startsWith('enc:v1:'));
  assert.equal(sec.decrypt(setTokenEncCalls[0].enc), 'FRESH_TOKEN');
  // Token meta recorded with the new expiry (so the UI card shows it).
  assert.equal(setTokenMetaCalls.length, 1);
  assert.equal(setTokenMetaCalls[0].info.type, 'THREADS');
  assert.ok(setTokenMetaCalls[0].info.expiresAt instanceof Date);
  assert.equal(setTokenMetaCalls[0].info.isValid, true);
  // Response returns ok + expiry, never the token.
  assert.equal(out.ok, true);
  assert.ok(out.expiresAt instanceof Date);
  assert.equal('access_token' in out, false);
  assert.equal('token' in out, false);
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
