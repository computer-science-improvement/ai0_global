import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingMtprotoClient } from './tracking-mtproto.client';

// We test ONLY the session-resolution bridge (resolveSessionString), not the
// gramjs connect path — so no network. The method prefers an active DB session
// and falls back to the existing .env value when none exists.

function makeClient(over: any = {}) {
  const config = { get: (k: string) => over.env?.[k] };
  const settings = { trackingShareSession: () => over.share ?? false, whenLoaded: async () => {} };
  const sessions = { activeSessionString: async () => (over.dbSession ?? null) };
  const secrets = {};
  const c = new TrackingMtprotoClient(config as any, settings as any, sessions as any, secrets as any);
  return c as any;
}

test('prefers the active DB session over the env value', async () => {
  const c = makeClient({
    dbSession: 'DB_SESSION',
    env: { TELEGRAM_TRACKING_SESSION_STRING: 'ENV_DEDICATED' },
  });
  assert.equal(await c.resolveSessionString(), 'DB_SESSION');
});

test('falls back to the dedicated env session when no active DB session', async () => {
  const c = makeClient({
    dbSession: null,
    env: { TELEGRAM_TRACKING_SESSION_STRING: 'ENV_DEDICATED' },
  });
  assert.equal(await c.resolveSessionString(), 'ENV_DEDICATED');
});

test('falls back to the shared env session when share is on and no DB/dedicated', async () => {
  const c = makeClient({
    dbSession: null,
    share: true,
    env: { TELEGRAM_SESSION_STRING: 'ENV_SHARED' },
  });
  assert.equal(await c.resolveSessionString(), 'ENV_SHARED');
});

test('returns empty string when nothing is configured (preserves disabled behavior)', async () => {
  const c = makeClient({ dbSession: null, env: {} });
  assert.equal(await c.resolveSessionString(), '');
});
