import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStatsClient } from './telegram-stats.client';

// Tests ONLY the session-resolution bridge — no gramjs connect, no network.

function makeClient(over: any = {}) {
  const config = { get: (k: string) => over.env?.[k] };
  const channelConfig = {};
  const sessions = { activeSessionString: async () => (over.dbSession ?? null) };
  const secrets = {};
  const c = new TelegramStatsClient(config as any, channelConfig as any, sessions as any, secrets as any);
  return c as any;
}

test('prefers the active DB session over TELEGRAM_SESSION_STRING', async () => {
  const c = makeClient({ dbSession: 'DB_SESSION', env: { TELEGRAM_SESSION_STRING: 'ENV_SESSION' } });
  assert.equal(await c.resolveSessionString(), 'DB_SESSION');
});

test('falls back to TELEGRAM_SESSION_STRING when no active DB session', async () => {
  const c = makeClient({ dbSession: null, env: { TELEGRAM_SESSION_STRING: 'ENV_SESSION' } });
  assert.equal(await c.resolveSessionString(), 'ENV_SESSION');
});

test('returns empty string when nothing configured (preserves disabled behavior)', async () => {
  const c = makeClient({ dbSession: null, env: {} });
  assert.equal(await c.resolveSessionString(), '');
});
