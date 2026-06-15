import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signState, verifyState } from './tiktok-oauth-state.util';

const SECRET = 'test-secret-32-characters-minimum!';

test('a freshly signed state verifies', () => {
  const token = signState(SECRET, 1000, 5000); // exp = 6000
  assert.equal(verifyState(SECRET, token, 1000), true);
  assert.equal(verifyState(SECRET, token, 5999), true);
});

test('an expired state does not verify', () => {
  const token = signState(SECRET, 1000, 5000); // exp = 6000
  assert.equal(verifyState(SECRET, token, 6000), false);
  assert.equal(verifyState(SECRET, token, 9999), false);
});

test('a tampered or wrong-secret state does not verify', () => {
  const token = signState(SECRET, 1000, 5000);
  assert.equal(verifyState(SECRET, token + 'x', 1000), false);
  assert.equal(verifyState('other-secret', token, 1000), false);
});

test('garbage never throws and returns false', () => {
  assert.equal(verifyState(SECRET, '', 1000), false);
  assert.equal(verifyState(SECRET, 'a.b', 1000), false);
  assert.equal(verifyState(SECRET, 'a.b.c', 1000), false);
});
