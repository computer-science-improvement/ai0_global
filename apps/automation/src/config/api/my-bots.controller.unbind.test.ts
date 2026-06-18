import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MyBotsController } from './my-bots.controller';

function make(over: any = {}) {
  const calls: any = { deleteWithUnbind: null, deleteIfUnbound: null, published: [] };
  const bots = {
    deleteWithUnbind: async (id: string) => { calls.deleteWithUnbind = id; return over.unbindResult ?? true; },
    deleteIfUnbound:  async (id: string) => { calls.deleteIfUnbound = id; return over.unboundResult ?? { ok: true, deleted: true }; },
  };
  const publisher = { publish: async (kind: string, id?: string) => { calls.published.push({ kind, id }); } };
  const c = new MyBotsController(
    bots as any, {} as any, { get: () => undefined } as any, publisher as any, {} as any,
  );
  return { c, calls };
}

test('delete with unbind=true calls deleteWithUnbind + publishes a bot reload', async () => {
  const { c, calls } = make();
  await c.remove('b1', 'true');
  assert.equal(calls.deleteWithUnbind, 'b1');
  assert.equal(calls.deleteIfUnbound, null);
  assert.deepEqual(calls.published, [{ kind: 'bot', id: 'b1' }]);
});

test('delete with unbind=true 404s when the bot is missing', async () => {
  const { c } = make({ unbindResult: false });
  await assert.rejects(() => c.remove('nope', 'true'), /not found/i);
});

test('delete WITHOUT unbind on a bound bot still 409s (reassign first)', async () => {
  const { c, calls } = make({ unboundResult: { ok: false, bound: 3 } });
  await assert.rejects(() => c.remove('b1'), /still bound to 3/i);
  assert.equal(calls.deleteWithUnbind, null);
  assert.equal(calls.published.length, 0);
});
