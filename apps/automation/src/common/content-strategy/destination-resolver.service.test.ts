import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DestinationResolver } from './destination-resolver.service';
import type { ResolvedStrategyBinding } from '../../config/channel-config.service';

function binding(over: Partial<ResolvedStrategyBinding> = {}): ResolvedStrategyBinding {
  return {
    id: 'recipes-ig', uuid: 'u1', type: 'recipes', channelId: '',
    schedule: '0 9 * * *', params: {}, enabled: true,
    platform: 'instagram', metaAccountId: 'acct-1', ...over,
  };
}

const account = {
  id: 'acct-1', platform: 'instagram', account_id: 'ai0_global_ig',
  token_env: 'INSTAGRAM_TOKEN', target_id: '17841480657952058',
  username: 'ai0.global.info', display_name: null, followers: null,
  picture_url: null, active: true, last_verified_at: null, verify_error: null,
  created_at: new Date(),
};

function make(over: { account?: any; env?: Record<string, string> } = {}) {
  const repo = { findById: async (_id: string) => (over.account === undefined ? account : over.account) };
  const config = { get: (k: string) => (over.env ?? { INSTAGRAM_TOKEN: 'tok-123' })[k] };
  return new DestinationResolver(repo as any, config as any);
}

test('telegram binding maps to channel destination', async () => {
  const r = make();
  const d = await r.resolve(binding({ platform: 'telegram', channelId: '@ai0_recipes', metaAccountId: null }));
  assert.equal(d.platform, 'telegram');
  assert.equal(d.targetId, '@ai0_recipes');
  assert.equal(d.postedKey, 'TELEGRAM');
  assert.equal(d.throttleKey, '@ai0_recipes');
  assert.equal(d.token, undefined);
  assert.equal(d.metaAccountId, null);
});

test('instagram binding resolves token + per-account keys', async () => {
  const r = make();
  const d = await r.resolve(binding());
  assert.equal(d.platform, 'instagram');
  assert.equal(d.targetId, '17841480657952058');
  assert.equal(d.token, 'tok-123');
  assert.equal(d.metaAccountId, 'acct-1');
  assert.equal(d.postedKey, 'IG:acct-1');
  assert.equal(d.throttleKey, 'meta:acct-1');
});

test('throws when meta account not found', async () => {
  const r = make({ account: null });
  await assert.rejects(() => r.resolve(binding()), /meta account acct-1 not found/);
});

test('throws when meta account inactive', async () => {
  const r = make({ account: { ...account, active: false } });
  await assert.rejects(() => r.resolve(binding()), /inactive/);
});

test('throws when token env unset', async () => {
  const r = make({ env: {} });
  await assert.rejects(() => r.resolve(binding()), /token env INSTAGRAM_TOKEN not set/);
});

test('throws when meta binding has no meta_account_id', async () => {
  const r = make();
  await assert.rejects(() => r.resolve(binding({ metaAccountId: null })), /requires a meta_account_id/);
});

test('facebook and threads resolve their own posted-key prefixes', async () => {
  for (const [platform, prefix] of [['facebook', 'FB'], ['threads', 'TH']] as const) {
    const r = make({ account: { ...account, platform } });
    const d = await r.resolve(binding({ platform }));
    assert.equal(d.platform, platform);
    assert.equal(d.postedKey, `${prefix}:acct-1`);
    assert.equal(d.throttleKey, 'meta:acct-1');
  }
});
