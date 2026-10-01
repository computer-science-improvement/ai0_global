import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'telegram';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { FloodWindow } from '../common/telegram/flood-wait';

// Only the flood gate is exercised — no TelegramClient is ever constructed
// (that would connect). While the window is open the client must return []
// BEFORE even looking up the session.

function makeClient() {
  const calls = { activeSession: 0 };
  const sessions = { activeSession: async () => { calls.activeSession++; return null; } };
  const c: any = new AgentMtprotoClient(sessions as any, {} as any, { get: () => undefined } as any);
  return { c, calls };
}

test('while flooded, all agent reads return [] without touching the session/Telegram', async () => {
  const { c, calls } = makeClient();
  let now = 1_000_000;
  c.flood = new FloodWindow(() => now);
  c.noteFlood(new errors.FloodWaitError({ capture: 120, request: undefined }), 'fetchRecentDialogs');

  assert.deepEqual(await c.fetchRecentDialogs(), []);
  assert.deepEqual(await c.listGroups(), []);
  assert.deepEqual(await c.fetchChatMessages('-100123', 0), []);
  assert.equal(calls.activeSession, 0);

  now += 120_000;                         // window over → normal path resumes
  assert.deepEqual(await c.fetchRecentDialogs(), []);   // [] because no session in the fake
  assert.equal(calls.activeSession, 1);
});

test('noteFlood ignores non-flood errors', async () => {
  const { c, calls } = makeClient();
  assert.equal(c.noteFlood(new Error('CHAT_ADMIN_REQUIRED'), 'listGroups'), false);
  await c.listGroups();
  assert.equal(calls.activeSession, 1);
});
