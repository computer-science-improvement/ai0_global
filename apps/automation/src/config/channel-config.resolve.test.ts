import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelConfigService } from './channel-config.service';

function svc(bindings: any[], channels: any[] = []) {
  const cache = {
    getBindings: () => bindings,
    getChannelById: (id: string) => channels.find(c => c.id === id) ?? null,
  };
  // ChannelConfigService(env, cache, importer) — only `cache` is used by
  // resolveStrategyBindings(); pass undefined for env + importer.
  return new ChannelConfigService(undefined as any, cache as any, undefined as any);
}

test('telegram binding resolves channel_key + telegram destination fields', () => {
  const s = svc(
    [{ id: 'b1', ext_id: 'recipes-tg', type: 'recipes', channel_id: 'uuid-1',
       schedule: '0 9 * * *', params: {}, enabled: true,
       platform: 'telegram', meta_account_id: null }],
    [{ id: 'uuid-1', channel_key: '@ai0_recipes' }],
  );
  const [r] = s.resolveStrategyBindings();
  assert.equal(r.channelId, '@ai0_recipes');
  assert.equal(r.platform, 'telegram');
  assert.equal(r.metaAccountId, null);
});

test('meta binding resolves empty channelId + platform/account', () => {
  const s = svc(
    [{ id: 'b2', ext_id: 'recipes-ig', type: 'recipes', channel_id: null,
       schedule: '0 9 * * *', params: {}, enabled: true,
       platform: 'instagram', meta_account_id: 'acct-1' }],
  );
  const [r] = s.resolveStrategyBindings();
  assert.equal(r.channelId, '');
  assert.equal(r.platform, 'instagram');
  assert.equal(r.metaAccountId, 'acct-1');
});
