import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokOAuthService } from './tiktok-oauth.service';

function cfg(over: Record<string, string | undefined> = {}) {
  const vars: Record<string, string | undefined> = {
    TIKTOK_CLIENT_KEY: 'ck', TIKTOK_REDIRECT_URI: 'https://api.x/cb',
    TIKTOK_SCOPES: 'user.info.basic,video.publish', JWT_SECRET: 'secret-secret-secret', ...over,
  };
  return { get: (k: string) => vars[k] } as any;
}

test('buildAuthorizeUrl includes client_key, scope, redirect, response_type, and a valid state', () => {
  const svc = new TikTokOAuthService(cfg());
  const url = svc.buildAuthorizeUrl(1000);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), 'ck');
  assert.equal(u.searchParams.get('scope'), 'user.info.basic,video.publish');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://api.x/cb');
  const state = u.searchParams.get('state')!;
  assert.equal(svc.verifyState(state, 1000), true);
});

test('buildAuthorizeUrl throws when client key or redirect is unset', () => {
  assert.throws(() => new TikTokOAuthService(cfg({ TIKTOK_CLIENT_KEY: undefined })).buildAuthorizeUrl(1000), /not configured/i);
  assert.throws(() => new TikTokOAuthService(cfg({ TIKTOK_REDIRECT_URI: undefined })).buildAuthorizeUrl(1000), /not configured/i);
});

test('verifyState rejects a forged token', () => {
  const svc = new TikTokOAuthService(cfg());
  assert.equal(svc.verifyState('not-a-real-state', 1000), false);
});
