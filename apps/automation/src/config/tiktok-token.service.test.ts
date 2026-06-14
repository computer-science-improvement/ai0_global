import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokTokenService } from './tiktok-token.service';

function fakeConfig(over: Record<string, string | undefined> = {}) {
  const vars: Record<string, string | undefined> = {
    TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs', TIKTOK_REDIRECT_URI: 'https://cb', ...over,
  };
  return { get: (k: string) => vars[k] } as any;
}

const FAR_FUTURE = new Date('2999-01-01T00:00:00Z');
const FAR_PAST   = new Date('2000-01-01T00:00:00Z');

function acct(over: any = {}) {
  return {
    id: 'a1', open_id: 'open1', access_token: 'OLD_AT', refresh_token: 'RT',
    access_token_expires_at: FAR_FUTURE, refresh_token_expires_at: FAR_FUTURE,
    active: true, ...over,
  };
}

function build(over: any = {}) {
  const calls: any = { posts: [], updated: null, upserted: null, refreshErr: null, deactivated: null };
  const repo = {
    findById: async () => over.account === undefined ? acct() : over.account,
    updateTokens: async (id: string, t: any) => { calls.updated = { id, t }; },
    upsertFromTokens: async (i: any) => { calls.upserted = i; return { id: 'a1', open_id: i.openId }; },
    setRefreshError: async (id: string, m: string) => { calls.refreshErr = { id, m }; },
    setActive: async (id: string, a: boolean) => { calls.deactivated = { id, a }; },
  };
  class TestSvc extends TikTokTokenService {
    constructor() { super(fakeConfig(over.env), repo as any); }
    protected post(url: string, form: Record<string, string>) {
      calls.posts.push({ url, form });
      if (over.postError) throw new Error(over.postError);
      return Promise.resolve(over.postResponse ?? {
        access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 86400, refresh_expires_in: 31536000,
        open_id: 'open1', scope: 'video.publish',
      });
    }
  }
  return { svc: new TestSvc(), calls };
}

test('getValidAccessToken returns the stored token when not near expiry (no network)', async () => {
  const { svc, calls } = build();
  const token = await svc.getValidAccessToken('a1');
  assert.equal(token, 'OLD_AT');
  assert.equal(calls.posts.length, 0);
});

test('getValidAccessToken refreshes when expired and returns the new token', async () => {
  const { svc, calls } = build({ account: acct({ access_token_expires_at: FAR_PAST }) });
  const token = await svc.getValidAccessToken('a1');
  assert.equal(token, 'NEW_AT');
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].form.grant_type, 'refresh_token');
  assert.equal(calls.posts[0].form.refresh_token, 'RT');
  assert.equal(calls.updated.t.accessToken, 'NEW_AT');
});

test('getValidAccessToken throws for a missing account', async () => {
  const { svc } = build({ account: null });
  await assert.rejects(() => svc.getValidAccessToken('a1'), /not found/i);
});

test('getValidAccessToken throws for an inactive account', async () => {
  const { svc } = build({ account: acct({ active: false }) });
  await assert.rejects(() => svc.getValidAccessToken('a1'), /inactive/i);
});

test('exchangeCode posts authorization_code and upserts parsed tokens', async () => {
  const { svc, calls } = build();
  const row = await svc.exchangeCode('AUTHCODE');
  assert.equal(calls.posts[0].form.grant_type, 'authorization_code');
  assert.equal(calls.posts[0].form.code, 'AUTHCODE');
  assert.equal(calls.posts[0].form.redirect_uri, 'https://cb');
  assert.equal(calls.upserted.openId, 'open1');
  assert.equal(calls.upserted.accessToken, 'NEW_AT');
  assert.equal(row.open_id, 'open1');
});

test('refresh failure records the error and rejects (no token in message)', async () => {
  const { svc, calls } = build({ account: acct({ access_token_expires_at: FAR_PAST }), postError: 'invalid_grant' });
  await assert.rejects(() => svc.getValidAccessToken('a1'), (e: any) => {
    assert.match(e.message, /refresh failed/i);
    assert.doesNotMatch(e.message, /RT|OLD_AT/);
    return true;
  });
  assert.equal(calls.refreshErr.id, 'a1');
});

test('missing client credentials throws a config error', async () => {
  // Use an expired account so the code path reaches refresh() -> creds().
  const { svc } = build({ account: acct({ access_token_expires_at: FAR_PAST }), env: { TIKTOK_CLIENT_KEY: undefined } });
  await assert.rejects(() => svc.getValidAccessToken('a1'), /credentials/i);
});
