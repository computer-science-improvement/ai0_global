import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MyBotsController } from './my-bots.controller';

function make(over: any = {}) {
  const calls: any = { setDefault: null, published: [] };
  const bots = {
    list: async () => over.list ?? [],
    findById: async (id: string) =>
      over.bot !== undefined ? over.bot : { id, bot_id: 'b', is_default: false },
    setDefault: async (id: string, value: boolean) => { calls.setDefault = { id, value }; },
  };
  const publisher = { publish: async (kind: string, id?: string) => { calls.published.push({ kind, id }); } };
  const c = new MyBotsController(
    bots as any, {} as any, { get: () => undefined } as any, publisher as any, {} as any,
  );
  return { c, calls };
}

test('set-default calls repo.setDefault and publishes a bot reload', async () => {
  const { c, calls } = make();
  const res = await c.setDefault('bot-1', { default: true } as any);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.setDefault, { id: 'bot-1', value: true });
  assert.deepEqual(calls.published, [{ kind: 'bot', id: 'bot-1' }]);
});

test('set-default toggling off passes value=false', async () => {
  const { c, calls } = make();
  await c.setDefault('bot-1', { default: false } as any);
  assert.deepEqual(calls.setDefault, { id: 'bot-1', value: false });
});

test('set-default 404s when the bot is missing', async () => {
  const { c, calls } = make({ bot: null });
  await assert.rejects(() => c.setDefault('nope', { default: true } as any), /not found/i);
  assert.equal(calls.setDefault, null);
  assert.equal(calls.published.length, 0);
});

test('list includes is_default in the projection', async () => {
  const { c } = make({
    list: [
      { id: 'b1', bot_id: 'one', username: null, first_name: null, platform: 'telegram',
        token_env: 'X', active: true, is_default: true, last_verified_at: null,
        verify_error: null, created_at: new Date() },
    ],
  });
  const out = await c.list();
  assert.equal(out[0].is_default, true);
});
