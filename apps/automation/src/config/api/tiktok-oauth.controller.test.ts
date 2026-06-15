import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokOAuthController } from './tiktok-oauth.controller';

function build(over: any = {}) {
  const calls: any = { exchanged: null };
  const oauth = {
    buildAuthorizeUrl: () => 'https://www.tiktok.com/v2/auth/authorize/?x=1',
    verifyState: (_t: string) => over.stateValid ?? true,
  };
  const tokens = {
    exchangeCode: async (code: string) => { calls.exchanged = code; if (over.exchangeThrow) throw new Error(over.exchangeThrow); return { id: 'a1' }; },
  };
  const env = { get: (k: string) => (k === 'DASHBOARD_URL' ? 'https://dash.x' : undefined) };
  return { ctrl: new TikTokOAuthController(oauth as any, tokens as any, env as any), calls };
}

test('start returns the authorize url', () => {
  const { ctrl } = build();
  assert.deepEqual(ctrl.start(), { url: 'https://www.tiktok.com/v2/auth/authorize/?x=1' });
});

test('callback with a valid state exchanges the code and redirects to connected', async () => {
  const { ctrl, calls } = build();
  const out = await ctrl.callback('CODE', 'STATE', undefined);
  assert.equal(calls.exchanged, 'CODE');
  assert.equal(out.url, 'https://dash.x/connections/tiktok?tiktok=connected');
});

test('callback with an invalid state does NOT exchange and redirects to error', async () => {
  const { ctrl, calls } = build({ stateValid: false });
  const out = await ctrl.callback('CODE', 'STATE', undefined);
  assert.equal(calls.exchanged, null);
  assert.equal(out.url, 'https://dash.x/connections/tiktok?tiktok=error');
});

test('callback with a TikTok error param redirects to error', async () => {
  const { ctrl, calls } = build();
  const out = await ctrl.callback(undefined, undefined, 'access_denied');
  assert.equal(calls.exchanged, null);
  assert.match(out.url, /tiktok=error$/);
});

test('callback where exchange throws redirects to error', async () => {
  const { ctrl } = build({ exchangeThrow: 'boom' });
  const out = await ctrl.callback('CODE', 'STATE', undefined);
  assert.match(out.url, /tiktok=error$/);
});
