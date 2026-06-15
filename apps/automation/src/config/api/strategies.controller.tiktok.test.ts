import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function build() {
  const inserted: any[] = [];
  const repo = { findByExtId: async () => null, insert: async (r: any) => { inserted.push(r); return { id: 'b1', ...r }; } };
  const registry = {
    types: () => ['recipe-carousel', 'ai0-news'],
    supportedPlatforms: (t: string) => t === 'recipe-carousel' ? ['instagram', 'facebook', 'threads', 'tiktok'] : ['telegram'],
  };
  const tiktokAccounts = { findById: async (id: string) => (id === 'tt1' ? { id: 'tt1', active: true } : null) };
  const cache = { getChannelById: () => ({ id: 'c' }) };
  const publisher = { publish: async () => {} };
  const c = new StrategiesController(
    repo as any, {} as any, {} as any, cache as any, publisher as any,
    {} as any, {} as any, { findById: async () => null } as any, registry as any, tiktokAccounts as any,
  );
  return { c, inserted };
}

test('GET /types returns supportedPlatforms per strategy', () => {
  const { c } = build();
  const types = c.listTypes();
  assert.deepEqual(types.find((t: any) => t.type === 'recipe-carousel')!.supportedPlatforms, ['instagram', 'facebook', 'threads', 'tiktok']);
});

test('create a tiktok binding inserts tiktok_account_id', async () => {
  const { c, inserted } = build();
  await c.create({ ext_id: 'recipe-carousel:tt', type: 'recipe-carousel', platform: 'tiktok', tiktok_account_id: 'tt1', schedule: '0 * * * *' } as any);
  assert.equal(inserted[0].platform, 'tiktok');
  assert.equal(inserted[0].tiktok_account_id, 'tt1');
});

test('rejects a strategy that does not support the platform', async () => {
  const { c } = build();
  await assert.rejects(() => c.create({ ext_id: 'ai0-news:tt', type: 'ai0-news', platform: 'tiktok', tiktok_account_id: 'tt1', schedule: '0 * * * *' } as any), /does not support platform tiktok/);
});

test('rejects a tiktok binding with an unknown account', async () => {
  const { c } = build();
  await assert.rejects(() => c.create({ ext_id: 'recipe-carousel:tt', type: 'recipe-carousel', platform: 'tiktok', tiktok_account_id: 'nope', schedule: '0 * * * *' } as any), /tiktok account nope not found/);
});
