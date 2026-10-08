// Spec 023 FR-013 phase A: /api/strategies is read-only legacy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function build(existing: any = { id: 'b1', ext_id: 'recipes:a', type: 'recipes', platform: 'telegram', enabled: true, retired_at: null }) {
  const updated: any[] = [];
  const published: string[] = [];
  const repo = {
    findById: async (id: string) => (id === existing?.id ? existing : null),
    findByExtId: async () => null,
    insert: async () => { throw new Error('insert must never be called'); },
    update: async (id: string, patch: any) => { updated.push(patch); return { ...existing, ...patch }; },
  };
  const registry = {
    types: () => ['recipe-carousel', 'ai0-news'],
    supportedPlatforms: (t: string) => (t === 'recipe-carousel' ? ['instagram', 'facebook', 'threads', 'tiktok'] : ['telegram']),
  };
  const c = new StrategiesController(
    repo as any, {} as any, {} as any, { getChannelById: () => ({ id: 'c' }) } as any, { publish: async (_k: string, id: string) => { published.push(id); } } as any,
    {} as any, {} as any, {} as any, registry as any, {} as any,
  );
  return { c, updated, published };
}

const gone = (err: any, refused?: string[]) => {
  assert.equal(err.getStatus(), 410);
  assert.equal(err.getResponse().error, 'strategies_legacy');
  if (refused) assert.deepEqual(err.getResponse().refused, refused);
  return true;
};

test('GET /types still returns supportedPlatforms per strategy (read-only)', () => {
  const types = build().c.listTypes();
  assert.deepEqual(types.find((t: any) => t.type === 'recipe-carousel')!.supportedPlatforms, ['instagram', 'facebook', 'threads', 'tiktok']);
});

test('POST /api/strategies → 410 strategies_legacy, nothing inserted', () => {
  assert.throws(() => build().c.create({ ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', channel_id: 'c' }), (err: any) => gone(err));
});

test('PATCH: pausing and notes are allowed; pausing publishes config:changed', async () => {
  const { c, updated, published } = build();
  await c.patch('b1', { enabled: false } as any);
  await c.patch('b1', { notes: 'kept for history' } as any);
  assert.deepEqual(updated, [{ enabled: false }, { notes: 'kept for history' }]);
  assert.deepEqual(published, ['b1']);
});

test('PATCH: enabling and every other field → 410 with the refused fields', async () => {
  const { c, updated } = build({ id: 'b1', ext_id: 'recipes:a', type: 'recipes', platform: 'telegram', enabled: false, retired_at: null });
  await assert.rejects(() => c.patch('b1', { enabled: true } as any), (err: any) => gone(err, ['enabled']));
  await assert.rejects(() => c.patch('b1', { schedule: '0 10 * * *', notes: 'x' } as any), (err: any) => gone(err, ['schedule']));
  await assert.rejects(() => c.patch('b1', { ext_id: 'renamed', params: {}, channel_id: 'c2', platform: 'tiktok', tiktok_account_id: 't' } as any),
    (err: any) => gone(err, ['ext_id', 'params', 'channel_id', 'platform', 'tiktok_account_id']));
  assert.deepEqual(updated, []);
});

test('PATCH enabled:true on a retired binding → 409 binding_retired (before the 410)', async () => {
  const { c } = build({ id: 'b1', ext_id: 'recipes:a', type: 'recipes', platform: 'telegram', enabled: false, retired_at: new Date(), migrated_to: { handle: 'chef' } });
  await assert.rejects(() => c.patch('b1', { enabled: true } as any), (err: any) => err.getStatus() === 409 && err.getResponse().error === 'binding_retired');
  await assert.rejects(() => c.patch('nope', { notes: 'x' } as any), /not found/);
});
