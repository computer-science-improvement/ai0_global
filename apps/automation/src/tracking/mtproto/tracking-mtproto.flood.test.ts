import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'telegram';
import { TrackingMtprotoClient } from './tracking-mtproto.client';
import { FloodWaitActiveError, FloodWindow, isFloodWait } from '../../common/telegram/flood-wait';

// Flood-wait handling with a fake gramjs client — no network. The client is
// marked ready and given a stub `client` whose invoke() throws a real GramJS
// FloodWaitError; we assert the error is surfaced with its seconds and that
// follow-up calls are skipped (Telegram not touched) while the window is open.

function makeClient(invokeImpl: () => Promise<any>) {
  const config   = { get: () => undefined };
  const settings = { trackingShareSession: () => false, whenLoaded: async () => {} };
  const sessions = { activeSession: async () => null };
  const c: any = new TrackingMtprotoClient(config as any, settings as any, sessions as any, {} as any);
  const calls = { invoke: 0, getEntity: 0 };
  c.ready  = true;
  c.client = {
    getEntity: async () => { calls.getEntity++; return { id: 123 }; },
    invoke:    async () => { calls.invoke++; return invokeImpl(); },
    getDialogs: async () => [],
  };
  return { c, calls };
}

const flood = (s: number) => new errors.FloodWaitError({ capture: s, request: undefined });

test('getHistory: a GramJS FloodWaitError is re-thrown with its seconds', async () => {
  const { c } = makeClient(async () => { throw flood(37); });
  await assert.rejects(
    () => c.getHistory('-1001234567890', 0, 50),
    (e: unknown) => e instanceof FloodWaitActiveError && isFloodWait(e) === 37,
  );
});

test('while flooded, every call is skipped without touching Telegram', async () => {
  const { c, calls } = makeClient(async () => { throw flood(300); });
  await assert.rejects(() => c.getHistory('-1001234567890', 0, 50), FloodWaitActiveError);
  const before = { ...calls };

  await assert.rejects(() => c.getHistory('-1001234567890', 0, 50), FloodWaitActiveError);
  await assert.rejects(() => c.getFullChannel('-1001234567890'), FloodWaitActiveError);
  await assert.rejects(() => c.resolveUsername('somechannel'), FloodWaitActiveError);
  await assert.rejects(() => c.checkInvite('AbCdEf'), FloodWaitActiveError);

  assert.deepEqual(calls, before, 'no gramjs calls while the flood window is open');
});

test('calls resume after the flood window expires', async () => {
  let fail = true;
  let now  = 1_000_000;
  const { c, calls } = makeClient(async () => {
    if (fail) throw flood(30);
    return { messages: [] };
  });
  c.flood = new FloodWindow(() => now);
  await assert.rejects(() => c.getHistory('-1001234567890', 0, 50), FloodWaitActiveError);
  fail = false;
  now += 29_000;
  await assert.rejects(() => c.getHistory('-1001234567890', 0, 50), FloodWaitActiveError);
  assert.equal(calls.invoke, 1);
  now += 1_000;
  assert.deepEqual(await c.getHistory('-1001234567890', 0, 50), []);
  assert.equal(calls.invoke, 2);
});

test('non-flood errors keep the old behaviour (logged, empty result, no window)', async () => {
  const { c, calls } = makeClient(async () => { throw new Error('INTERNAL'); });
  assert.deepEqual(await c.getHistory('-1001234567890', 0, 50), []);
  assert.deepEqual(await c.getHistory('-1001234567890', 0, 50), []);
  assert.equal(calls.invoke, 2);
});
