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

/** Same contract as SecretsService.resolveToken: enc wins, else env via configGet. */
const fakeSecrets = {
  resolveToken: (o: { enc?: string | null; env?: string | null }, get: (k: string) => string | undefined) =>
    o.enc ? `dec(${o.enc})` : o.env ? get(o.env) : undefined,
};

function build(targets: any[], config: any = { get: () => 'token' }) {
  const published: Array<{ platform: string; imageUrl?: string; token?: string }> = [];
  const svc = new CrossPostService(
    { listEnabledResolved: async () => targets } as any,                       // targets repo
    { getChannelMeta: () => ({ id: 'ch1', username: 'chan' }) } as any,        // channel config
    { publish: async (p: string, payload: any, target: any) => { published.push({ platform: p, imageUrl: payload.imageUrl, token: target.token }); return 'mid'; } } as any, // dispatcher
    { tryLock: () => true, recordPublish: () => {}, releaseLock: () => {} } as any, // throttle
    { metaCooldownMin: () => 0 } as any,                                       // settings
    config,                                                                    // config
    fakeSecrets as any,                                                        // secrets
  );
  return { svc, published };
}

test('token: an encrypted account token (token_enc) is used even with no env var set', async () => {
  const t = { ...target('facebook'), account_token_env: null, account_token_enc: 'enc:v1:abc' };
  const { svc, published } = build([t], { get: () => undefined });
  await svc.afterPublish({ channelKey: '@c', messageId: 1, mirror: { text: 'hello', tags: [] } });
  assert.deepEqual(published.map(p => p.token), ['dec(enc:v1:abc)']);
});

test('token: falls back to the legacy token_env when token_enc is null', async () => {
  const t = { ...target('facebook'), account_token_enc: null };
  const { svc, published } = build([t], { get: (k: string) => (k === 'TOK_ENV' ? 'env-token' : undefined) });
  await svc.afterPublish({ channelKey: '@c', messageId: 1, mirror: { text: 'hello', tags: [] } });
  assert.deepEqual(published.map(p => p.token), ['env-token']);
});

test('token: neither enc nor env resolves → target skipped, nothing published', async () => {
  const t = { ...target('facebook'), account_token_enc: null, account_token_env: null };
  const { svc, published } = build([t], { get: () => undefined });
  await svc.afterPublish({ channelKey: '@c', messageId: 1, mirror: { text: 'hello', tags: [] } });
  assert.deepEqual(published, []);
});

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
