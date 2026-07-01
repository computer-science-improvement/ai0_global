import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStatsClient } from './telegram-stats.client';

// Tests ONLY the session-resolution bridge (resolveConnection) — no gramjs
// connect, no network. Prefers an active DB session with its own app creds.

function makeClient(over: any = {}) {
  const config = { get: (k: string) => over.env?.[k] };
  const channelConfig = {};
  const sessions = { activeSession: async () => (over.dbSession ?? null) };
  const secrets = {};
  const c = new TelegramStatsClient(config as any, channelConfig as any, sessions as any, secrets as any);
  return c as any;
}

test('prefers the active DB session + its own api creds over env', async () => {
  const c = makeClient({
    dbSession: { session: 'DB_SESSION', apiId: 42, apiHash: 'DB_HASH' },
    env: { TELEGRAM_SESSION_STRING: 'ENV_SESSION', TELEGRAM_API_ID: '11', TELEGRAM_API_HASH: 'ENV_HASH' },
  });
  assert.deepEqual(await c.resolveConnection(), { session: 'DB_SESSION', apiId: 42, apiHash: 'DB_HASH' });
});

test('active DB session with no own api creds falls back to env api creds', async () => {
  const c = makeClient({
    dbSession: { session: 'DB_SESSION', apiId: null, apiHash: null },
    env: { TELEGRAM_API_ID: '11', TELEGRAM_API_HASH: 'ENV_HASH' },
  });
  assert.deepEqual(await c.resolveConnection(), { session: 'DB_SESSION', apiId: 11, apiHash: 'ENV_HASH' });
});

test('falls back to TELEGRAM_SESSION_STRING + env api creds when no active DB session', async () => {
  const c = makeClient({ dbSession: null, env: { TELEGRAM_SESSION_STRING: 'ENV_SESSION', TELEGRAM_API_ID: '11', TELEGRAM_API_HASH: 'ENV_HASH' } });
  assert.deepEqual(await c.resolveConnection(), { session: 'ENV_SESSION', apiId: 11, apiHash: 'ENV_HASH' });
});

test('returns empty session when nothing configured (preserves disabled behavior)', async () => {
  const c = makeClient({ dbSession: null, env: {} });
  const out = await c.resolveConnection();
  assert.equal(out.session, '');
});
