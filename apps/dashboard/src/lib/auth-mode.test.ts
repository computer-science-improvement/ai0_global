// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devAuthBuildError, isLocalHost, resolveAuthMode, tokenFormEnabled } from './auth-mode';

test('resolveAuthMode: Telegram wins, then token, else dev', () => {
  assert.equal(resolveAuthMode({ VITE_TG_BOT_USERNAME: 'ai0bot', VITE_AUTH_MODE: 'token' }), 'telegram');
  assert.equal(resolveAuthMode({ VITE_AUTH_MODE: 'token' }), 'token');
  assert.equal(resolveAuthMode({ VITE_AUTH_MODE: '', VITE_TG_BOT_USERNAME: '' }), 'dev');
  assert.equal(resolveAuthMode({ VITE_TG_BOT_USERNAME: '  ' }), 'dev');
  assert.equal(resolveAuthMode({}), 'dev');
  assert.equal(tokenFormEnabled({ VITE_TG_BOT_USERNAME: 'ai0bot', VITE_AUTH_MODE: 'token' }), true);
  assert.equal(tokenFormEnabled({ VITE_TG_BOT_USERNAME: 'ai0bot' }), false);
});

test('devAuthBuildError: a production build needs a sign-in method or the explicit escape hatch', () => {
  assert.match(devAuthBuildError({ VITE_AUTH_MODE: '', VITE_TG_BOT_USERNAME: '' }) ?? '', /Refusing a production build/);
  assert.equal(devAuthBuildError({ VITE_AUTH_MODE: 'token' }), null);
  assert.equal(devAuthBuildError({ VITE_TG_BOT_USERNAME: 'ai0bot' }), null);
  assert.equal(devAuthBuildError({ VITE_ALLOW_DEV_AUTH: 'true' }), null);
  assert.notEqual(devAuthBuildError({ VITE_ALLOW_DEV_AUTH: '1' }), null);
});

test('isLocalHost: only loopback names get the dev "Continue"', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', 'app.localhost', 'LOCALHOST']) assert.equal(isLocalHost(h), true, h);
  for (const h of ['dev.ai0.global', '10.0.0.5', '192.168.1.2', 'localhost.evil.com', 'mylocalhost']) assert.equal(isLocalHost(h), false, h);
});
