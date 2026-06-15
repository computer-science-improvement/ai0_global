import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function make(over: any = {}) {
  const repo = {
    findByExtId: async () => null,
    insert: async (row: any) => ({ id: 'new', ...row }),
    findById: async () => null,
    update: async () => null,
    ...over.repo,
  };
  const cache = { getChannelById: (id: string) => (over.channelExists === false ? null : { id }) };
  const metaAccounts = { findById: async () => (over.accountExists === false ? null : { id: 'acct-1', active: true }) };
  const publisher = { publish: async () => {} };
  // Constructor order: repo, runsRepo, preview, cache, publisher, crossposts, runway, metaAccounts
  return new StrategiesController(
    repo as any,        // repo
    {} as any,          // runsRepo
    {} as any,          // preview
    cache as any,       // cache
    publisher as any,   // publisher
    {} as any,          // crossposts
    {} as any,          // runway
    metaAccounts as any,// metaAccounts
    { types: () => [], supportedPlatforms: () => ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'] } as any,
    { findById: async () => null } as any,
  );
}

test('telegram binding requires channel_id', async () => {
  const c = make();
  await assert.rejects(
    () => c.create({ ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', platform: 'telegram' } as any),
    /channel_id is required/,
  );
});

test('meta binding requires meta_account_id', async () => {
  const c = make();
  await assert.rejects(
    () => c.create({ ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', platform: 'instagram' } as any),
    /meta_account_id is required/,
  );
});

test('meta binding rejects unknown account', async () => {
  const c = make({ accountExists: false });
  await assert.rejects(
    () => c.create({ ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', platform: 'instagram', meta_account_id: 'nope' } as any),
    /meta account .* not found/,
  );
});

test('patch rejects setting both channel_id and meta_account_id', async () => {
  const c = make({ repo: { findById: async () => ({ id: 's1', platform: 'telegram' }) } });
  await assert.rejects(
    () => c.patch('s1', { channel_id: 'chan-1', meta_account_id: 'acct-1' } as any),
    /cannot set both channel_id and meta_account_id/,
  );
});

test('valid meta binding inserts with platform + meta_account_id', async () => {
  const c = make();
  const row = await c.create({ ext_id: 'recipes-ig', type: 'recipes', schedule: '0 9 * * *', platform: 'instagram', meta_account_id: 'acct-1' } as any);
  assert.equal(row.platform, 'instagram');
  assert.equal(row.meta_account_id, 'acct-1');
  assert.equal(row.channel_id ?? null, null);
});
