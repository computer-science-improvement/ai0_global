// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeLabel, EVENT_LABEL, LOGIN_ERROR_CODES, loginErrorMessage, reasonMessage, stripTokenParam } from './messages';

const ENV_NAME = /\b(?:VITE|TRACKING|TELEGRAM|JWT|ALLOW)_[A-Z_]+\b/;

test('every FR-007 login code renders its own plain message, with no env var names', () => {
  const seen = new Set<string>();
  for (const code of LOGIN_ERROR_CODES) {
    const m = loginErrorMessage(code, 42);
    assert.ok(m.length > 10, code);
    assert.doesNotMatch(m, ENV_NAME, code);
    seen.add(m);
  }
  assert.equal(seen.size, LOGIN_ERROR_CODES.length, 'each code has a distinct message');
  assert.equal(loginErrorMessage('rate_limited', 42), 'Too many attempts, try again in 42 s.');
  assert.equal(loginErrorMessage('locked_out', 3600), 'Too many failed attempts from your network. Try again in 60 min.');
  assert.equal(loginErrorMessage('token_login_disabled'), 'Token sign-in is not enabled on this server.');
  assert.equal(loginErrorMessage('network'), "Can't reach the server. Check your connection and try again.");
  assert.equal(loginErrorMessage('something-new'), loginErrorMessage('unknown'));
});

test('reason banners for the 401 codes; none for a plain missing cookie', () => {
  assert.equal(reasonMessage('session_expired'), 'Your session expired. Please sign in again.');
  assert.equal(reasonMessage('session_revoked'), 'You were signed out from another device.');
  assert.equal(reasonMessage('session_legacy'), 'Please sign in again after the security update.');
  assert.equal(reasonMessage('no_credentials'), null);
  assert.equal(reasonMessage(undefined), null);
});

test('stripTokenParam removes the token and keeps everything else, incl. a raw nginx next', () => {
  assert.equal(stripTokenParam('?token=abc'), '');
  assert.equal(stripTokenParam('?token=abc&next=%2Fapp%2Fx'), '?next=%2Fapp%2Fx');
  assert.equal(stripTokenParam('?reason=session_expired&token=abc'), '?reason=session_expired');
  assert.equal(stripTokenParam('?token=abc&reason=&next=/app/a?b=1&token=keep'), '?reason=&next=/app/a?b=1&token=keep');
  assert.equal(stripTokenParam('?tokenish=1'), '?tokenish=1');
  assert.equal(stripTokenParam(''), '');
});

test('audit labels: every event kind has a label; codes read as words', () => {
  for (const k of ['login_ok', 'login_failed', 'rate_limited', 'locked_out', 'logout', 'revoked', 'revoke_all', 'expired']) {
    assert.ok(EVENT_LABEL[k], k);
  }
  assert.equal(codeLabel('bad_token'), 'wrong token');
  assert.equal(codeLabel('brand_new_code'), 'brand new code');
  assert.equal(codeLabel(null), '');
});

test('no env var names in the login page or the Security tab', () => {
  for (const rel of ['../routes/login.tsx', '../components/settings/SecurityTab.tsx', './messages.ts']) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    // Only rendered text matters; strip comments and the import of env constants.
    const visible = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^import .*$/gm, '');
    const strings = visible.match(/(['"`])(?:(?!\1).)*\1|>[^<>{}]+</g) ?? [];
    for (const s of strings) assert.doesNotMatch(s, ENV_NAME, `${rel}: ${s}`);
  }
});
