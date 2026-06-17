import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountsController } from './meta-accounts.controller';

function make(over: any = {}) {
  const calls: any = { deleted: null, deletedBindings: null, published: [] };
  const accounts = {
    findById: async (id: string) =>
      over.account !== undefined ? over.account : { id, platform: 'facebook', target_id: 't1' },
    delete: async (id: string) => { calls.deleted = id; return over.deleteResult ?? true; },
  };
  const graph = {};
  const env = { get: () => 'tok' };
  const history = {};
  const insights = {};
  const collector = {};
  const bindings = {
    listByMetaAccount: async (_id: string) => over.bound ?? [],
    deleteByMetaAccount: async (id: string) => { calls.deletedBindings = id; return (over.bound ?? []).length; },
  };
  const publisher = { publish: async (kind: string, id?: string) => { calls.published.push({ kind, id }); } };
  const c = new MetaAccountsController(
    accounts as any, graph as any, env as any, history as any, insights as any,
    collector as any, bindings as any, publisher as any,
  );
  return { c, calls };
}

test('remove with no bound strategies deletes the account (no cascade path)', async () => {
  const { c, calls } = make({ bound: [] });
  await c.remove('acc-1');
  assert.equal(calls.deleted, 'acc-1');
  assert.equal(calls.deletedBindings, null);
  assert.equal(calls.published.length, 0);
});

test('remove 404s when the account does not exist', async () => {
  const { c } = make({ account: null });
  await assert.rejects(() => c.remove('nope'), /not found/i);
});

test('remove with bound strategies and no cascade throws 409 listing ext_ids; nothing deleted', async () => {
  const bound = [
    { ext_id: 'recipes:ig', type: 'recipe-carousel' },
    { ext_id: 'prompts:fb', type: 'ai0-prompts' },
  ];
  const { c, calls } = make({ bound });
  await assert.rejects(
    () => c.remove('acc-1'),
    (err: any) => {
      assert.equal(err.getStatus?.(), 409);
      assert.match(err.message, /recipes:ig/);
      assert.match(err.message, /prompts:fb/);
      assert.match(err.message, /2/);
      return true;
    },
  );
  assert.equal(calls.deleted, null);
  assert.equal(calls.deletedBindings, null);
  assert.equal(calls.published.length, 0);
});

test('remove with bound strategies and cascade=true deletes bindings, publishes reload, then deletes account', async () => {
  const order: string[] = [];
  const bound = [{ ext_id: 'recipes:ig', type: 'recipe-carousel' }];
  const { c, calls } = make({ bound });
  // Track ordering: bindings deleted BEFORE the account (FK), publish in between.
  const origDeleteBindings = (c as any).bindings.deleteByMetaAccount;
  (c as any).bindings.deleteByMetaAccount = async (id: string) => { order.push('bindings'); return origDeleteBindings.call((c as any).bindings, id); };
  const origPublish = (c as any).publisher.publish;
  (c as any).publisher.publish = async (k: string, i?: string) => { order.push('publish'); return origPublish.call((c as any).publisher, k, i); };
  const origDelete = (c as any).accounts.delete;
  (c as any).accounts.delete = async (id: string) => { order.push('account'); return origDelete.call((c as any).accounts, id); };

  await c.remove('acc-1', 'true');

  assert.equal(calls.deletedBindings, 'acc-1');
  assert.equal(calls.deleted, 'acc-1');
  assert.deepEqual(calls.published, [{ kind: 'strategy', id: 'acc-1' }]);
  assert.deepEqual(order, ['bindings', 'publish', 'account']);
});

test('remove 404s when account delete returns false', async () => {
  const { c } = make({ bound: [], deleteResult: false });
  await assert.rejects(() => c.remove('acc-1'), /not found/i);
});
