import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function makeController() {
  const repo = {
    list: async () => [
      { id: 'b1', ext_id: 'recipes-tg', type: 'recipes', channel_id: 'ch-1',
        schedule: '0 9 * * *', params: {}, enabled: false, notes: null,
        low_content_threshold: null, platform: 'telegram', meta_account_id: null },
      { id: 'b2', ext_id: 'recipes-ig', type: 'recipes', channel_id: null,
        schedule: '0 9 * * *', params: {}, enabled: false, notes: null,
        low_content_threshold: null, platform: 'instagram', meta_account_id: 'acct-1' },
    ],
  };
  const runsRepo = { latestPerStrategy: async () => new Map() };
  const cache = {
    getChannelById: (id: string) =>
      (id === 'ch-1' ? { id: 'ch-1', channel_key: '@ai0_recipes', title: 'Recipes' } : null),
    getForwardRoutesForSource: () => [],
  };
  const crossposts = { platformsByChannel: async () => new Map([['ch-1', ['facebook']]]) };
  const runway = { remainingFor: async () => 0, effectiveThreshold: () => 100 };
  const metaAccounts = {
    list: async () => [{ id: 'acct-1', platform: 'instagram', username: 'ai0.global.info' }],
  };
  // Constructor order: repo, runsRepo, preview, cache, publisher, crossposts, runway, metaAccounts
  return new StrategiesController(
    repo as any, runsRepo as any, {} as any, cache as any, {} as any,
    crossposts as any, runway as any, metaAccounts as any,
  );
}

test('list: telegram binding reports telegram + cross-post platforms', async () => {
  const out = await makeController().list();
  const tg = out.find((s: any) => s.ext_id === 'recipes-tg') as any;
  assert.equal(tg.platform, 'telegram');
  assert.deepEqual(tg.platforms, ['telegram', 'facebook']);
  assert.equal(tg.channel_key, '@ai0_recipes');
  assert.equal(tg.meta_account, null);
});

test('list: native meta binding reports its own platform + account label', async () => {
  const out = await makeController().list();
  const ig = out.find((s: any) => s.ext_id === 'recipes-ig') as any;
  assert.equal(ig.platform, 'instagram');
  assert.deepEqual(ig.platforms, ['instagram']);
  assert.equal(ig.channel_key, null);
  assert.deepEqual(ig.meta_account, { id: 'acct-1', platform: 'instagram', username: 'ai0.global.info' });
});
