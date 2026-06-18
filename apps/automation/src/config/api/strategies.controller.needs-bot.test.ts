import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function makeController(opts: { channelBotId: string | null; defaultBot: any }) {
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
      (id === 'ch-1'
        ? { id: 'ch-1', channel_key: '@ai0_recipes', title: 'Recipes', bot_id: opts.channelBotId }
        : null),
    getForwardRoutesForSource: () => [],
    getDefaultBot: () => opts.defaultBot,
  };
  const crossposts = { platformsByChannel: async () => new Map() };
  const runway = { remainingFor: async () => 0, effectiveThreshold: () => 100 };
  const metaAccounts = { list: async () => [{ id: 'acct-1', platform: 'instagram', username: 'x' }] };
  return new StrategiesController(
    repo as any, runsRepo as any, {} as any, cache as any, {} as any,
    crossposts as any, runway as any, metaAccounts as any,
    { types: () => [], supportedPlatforms: () => ['telegram', 'instagram'] } as any,
    { findById: async () => null } as any,
  );
}

test('needs_bot true: telegram channel has no bot bound and no default bot', async () => {
  const out = await makeController({ channelBotId: null, defaultBot: null }).list();
  const tg = out.find((s: any) => s.ext_id === 'recipes-tg') as any;
  assert.equal(tg.needs_bot, true);
});

test('needs_bot false: a default bot exists even when channel has no bot', async () => {
  const out = await makeController({ channelBotId: null, defaultBot: { id: 'd', is_default: true } }).list();
  const tg = out.find((s: any) => s.ext_id === 'recipes-tg') as any;
  assert.equal(tg.needs_bot, false);
});

test('needs_bot false: channel has a bot bound', async () => {
  const out = await makeController({ channelBotId: 'bound', defaultBot: null }).list();
  const tg = out.find((s: any) => s.ext_id === 'recipes-tg') as any;
  assert.equal(tg.needs_bot, false);
});

test('needs_bot false: non-telegram bindings never need a bot', async () => {
  const out = await makeController({ channelBotId: null, defaultBot: null }).list();
  const ig = out.find((s: any) => s.ext_id === 'recipes-ig') as any;
  assert.equal(ig.needs_bot, false);
});
