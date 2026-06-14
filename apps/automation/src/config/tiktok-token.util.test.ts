import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryFrom, toTokenSet } from './tiktok-token.util';

test('expiryFrom adds seconds to a base epoch (ms)', () => {
  assert.deepEqual(expiryFrom(1_000_000, 86400), new Date(1_000_000 + 86400_000));
});

test('toTokenSet maps a TikTok token response to absolute expiries', () => {
  const res = { access_token: 'AT', refresh_token: 'RT', expires_in: 86400, refresh_expires_in: 31536000 };
  const set = toTokenSet(res, 1_000_000);
  assert.equal(set.accessToken, 'AT');
  assert.equal(set.refreshToken, 'RT');
  assert.deepEqual(set.accessTokenExpiresAt, new Date(1_000_000 + 86400_000));
  assert.deepEqual(set.refreshTokenExpiresAt, new Date(1_000_000 + 31536000_000));
});
