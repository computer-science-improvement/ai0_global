import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingMtprotoClient } from './tracking-mtproto.client';

// We test ONLY the session-resolution bridge (resolveConnection), not the
// gramjs connect path — so no network. The method prefers an active DB session
// (with its own app creds) and falls back to the existing .env behavior when
// none exists.

function makeClient(over: any = {}) {
  const config = { get: (k: string) => over.env?.[k] };
  const settings = { trackingShareSession: () => over.share ?? false, whenLoaded: async () => {} };
  const sessions = { activeSession: async () => (over.dbSession ?? null) };
  const secrets = {};
  const c = new TrackingMtprotoClient(config as any, settings as any, sessions as any, secrets as any);
  return c as any;
}

test('prefers the active DB session + its own api creds over env', async () => {
  const c = makeClient({
    dbSession: { session: 'DB_SESSION', apiId: 42, apiHash: 'DB_HASH' },
    env: { TELEGRAM_TRACKING_SESSION_STRING: 'ENV_DEDICATED', TELEGRAM_API_ID: '11', TELEGRAM_API_HASH: 'ENV_HASH' },
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

test('falls back to the dedicated env session + env api creds when no active DB session', async () => {
  const c = makeClient({
    dbSession: null,
    env: { TELEGRAM_TRACKING_SESSION_STRING: 'ENV_DEDICATED', TELEGRAM_API_ID: '11', TELEGRAM_API_HASH: 'ENV_HASH' },
  });
  assert.deepEqual(await c.resolveConnection(), { session: 'ENV_DEDICATED', apiId: 11, apiHash: 'ENV_HASH' });
});

test('falls back to the shared env session when share is on and no DB/dedicated', async () => {
  const c = makeClient({
    dbSession: null,
    share: true,
    env: { TELEGRAM_SESSION_STRING: 'ENV_SHARED', TELEGRAM_API_ID: '11', TELEGRAM_API_HASH: 'ENV_HASH' },
  });
  assert.deepEqual(await c.resolveConnection(), { session: 'ENV_SHARED', apiId: 11, apiHash: 'ENV_HASH' });
});

test('returns empty session when nothing is configured (preserves disabled behavior)', async () => {
  const c = makeClient({ dbSession: null, env: {} });
  const out = await c.resolveConnection();
  assert.equal(out.session, '');
});
