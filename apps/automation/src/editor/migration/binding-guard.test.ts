import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoEnabledBindings, liveRefsOf } from './binding-guard';
import { StrategiesController } from '../../config/api/strategies.controller';

const fakePool = (rows: any[]): any => ({ query: async (sql: string) => ({ rows: /FROM strategy_bindings/.test(sql) ? rows : [] }) });

test('live guard: 409 bindings_still_enabled lists the ext_ids; no enabled binding passes', async () => {
  await assert.rejects(
    () => assertNoEnabledBindings(fakePool([{ ext_id: 'recipes:a', enabled: true, resource_ref: 'telegram:@c' }, { ext_id: 'quotes:a', enabled: true, resource_ref: 'telegram:@c' }]), ['telegram:@c']),
    (err: any) => {
      assert.equal(err.getStatus(), 409);
      assert.equal(err.getResponse().error, 'bindings_still_enabled');
      assert.deepEqual(err.getResponse().ext_ids, ['recipes:a', 'quotes:a']);
      return true;
    });
  await assertNoEnabledBindings(fakePool([]), ['telegram:@c']);
  await assertNoEnabledBindings(fakePool([{ ext_id: 'x' }]), []); // no resources → nothing to check
});

test('the refs a live switch covers: a resource, its Telegram group, or a network', async () => {
  assert.deepEqual(await liveRefsOf(fakePool([]), { scope: 'resource', scopeId: 'instagram:1' }), ['instagram:1']);
  const grouped: any = { query: async () => ({ rows: [{ ref: 'telegram:@c' }, { ref: 'instagram:9' }] }) };
  assert.deepEqual(await liveRefsOf(grouped, { scope: 'resource', scopeId: 'telegram:@c' }), ['telegram:@c', 'instagram:9']);
  assert.deepEqual(await liveRefsOf(grouped, { scope: 'network', scopeId: 'g1' }), ['telegram:@c', 'instagram:9']);
  assert.deepEqual(await liveRefsOf(grouped, { scope: 'system', scopeId: null }), []);
});

function controller(existing: any, updates: any[] = []) {
  return new StrategiesController(
    { findById: async () => existing, findByExtId: async () => null, update: async (_id: string, p: any) => { updates.push(p); return { ...existing, ...p }; } } as any,
    {} as any, {} as any, { getChannelById: () => ({}) } as any, { publish: async () => {} } as any,
    {} as any, {} as any, {} as any, { supportedPlatforms: () => ['telegram'] } as any, {} as any,
  );
}

test('re-enabling a retired binding → 409 binding_retired (pausing it stays allowed)', async () => {
  const retired = { id: 's1', ext_id: 'recipes:a', type: 'recipes', platform: 'telegram', enabled: false, retired_at: new Date(), retired_reason: 'migrated', migrated_to: { agent_id: 'a1', handle: 'chef' } };
  await assert.rejects(() => controller(retired).patch('s1', { enabled: true } as any), (err: any) => {
    assert.equal(err.getStatus(), 409);
    assert.equal(err.getResponse().error, 'binding_retired');
    assert.match(err.getResponse().details, /retired by the migration to @chef; use the Rollback card/);
    return true;
  });
  const updates: any[] = [];
  await controller({ ...retired, retired_at: null }, updates).patch('s1', { enabled: true } as any);
  assert.deepEqual(updates, [{ enabled: true }]);
});
