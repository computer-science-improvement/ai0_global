import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrossPostService } from './cross-post.service';

function target(platform: string, mode: 'mirror' | 'teaser' = 'mirror') {
  return {
    platform, mode,
    meta_account_id:   `acct-${platform}`,
    account_active:    true,
    account_token_env: 'TOK_ENV',
    account_target_id: `target-${platform}`,
  };
}

function build(targets: any[]) {
  const published: Array<{ platform: string; imageUrl?: string }> = [];
  const svc = new CrossPostService(
    { listEnabledResolved: async () => targets } as any,                       // targets repo
    { getChannelMeta: () => ({ id: 'ch1', username: 'chan' }) } as any,        // channel config
    { publish: async (p: string, payload: any) => { published.push({ platform: p, imageUrl: payload.imageUrl }); return 'mid'; } } as any, // dispatcher
    { tryLock: () => true, recordPublish: () => {}, releaseLock: () => {} } as any, // throttle
    { metaCooldownMin: () => 0 } as any,                                       // settings
    { get: () => 'token' } as any,                                             // config
  );
  return { svc, published };
}

test('imageless mirror: instagram skipped, threads/facebook still publish', async () => {
  const { svc, published } = build([target('instagram'), target('threads'), target('facebook')]);
  await svc.afterPublish({ channelKey: '@c', messageId: 1, mirror: { text: 'hello', tags: [] } });
  assert.deepEqual(published.map(p => p.platform).sort(), ['facebook', 'threads']);
});

test('mirror WITH image: instagram publishes', async () => {
  const { svc, published } = build([target('instagram')]);
  await svc.afterPublish({ channelKey: '@c', messageId: 1, mirror: { text: 'hello', tags: [], imageUrl: 'https://x/i.jpg' } });
  assert.deepEqual(published.map(p => p.platform), ['instagram']);
  assert.equal(published[0].imageUrl, 'https://x/i.jpg');
});

test('imageless teaser: instagram skipped, facebook publishes', async () => {
  const { svc, published } = build([target('instagram', 'teaser'), target('facebook', 'teaser')]);
  await svc.afterPublish({ channelKey: '@c', messageId: 1, teaser: { lines: ['a', 'b'] } });
  assert.deepEqual(published.map(p => p.platform), ['facebook']);
});
