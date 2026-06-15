import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokCarouselPublisher } from './tiktok-carousel.publisher';

function fakeConfig(privacy?: string) {
  return { get: (k: string) => (k === 'TIKTOK_PRIVACY_LEVEL' ? privacy : undefined) } as any;
}

function build(over: any = {}) {
  const calls: any = { tokenFor: null, init: null, statusCalls: 0, slept: 0 };
  const tokenService = {
    getValidAccessToken: async (id: string) => { calls.tokenFor = id; if (over.tokenThrow) throw new Error(over.tokenThrow); return 'TOK'; },
  };
  const statuses: string[] = over.statuses ?? ['PROCESSING_UPLOAD', 'PUBLISH_COMPLETE'];
  const client = {
    initPhotoPost: async (token: string, body: any) => { calls.init = { token, body }; return { publishId: 'pub_1' }; },
    fetchStatus: async () => {
      const s = statuses[Math.min(calls.statusCalls, statuses.length - 1)];
      calls.statusCalls++;
      return { status: s, failReason: over.failReason };
    },
  };
  class TestPub extends TikTokCarouselPublisher {
    constructor() { super(tokenService as any, client as any, fakeConfig(over.privacy)); }
    protected sleep(_ms: number) { calls.slept++; return Promise.resolve(); }
  }
  return { pub: new TestPub(), calls };
}

test('publishCarousel resolves a token, inits, polls to completion, returns publish_id', async () => {
  const { pub, calls } = build({ privacy: 'PUBLIC_TO_EVERYONE' });
  const id = await pub.publishCarousel('acc1', ['u1', 'u2', 'u3'], 'Pommes\n\nгортай');
  assert.equal(id, 'pub_1');
  assert.equal(calls.tokenFor, 'acc1');
  assert.equal(calls.init.token, 'TOK');
  assert.deepEqual(calls.init.body.source_info.photo_images, ['u1', 'u2', 'u3']);
  assert.equal(calls.init.body.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
  assert.equal(calls.init.body.post_info.title, 'Pommes');
  assert.equal(calls.statusCalls, 2);
});

test('publishCarousel defaults privacy to SELF_ONLY when env is unset', async () => {
  const { pub, calls } = build();
  await pub.publishCarousel('acc1', ['u1', 'u2'], 'cap');
  assert.equal(calls.init.body.post_info.privacy_level, 'SELF_ONLY');
});

test('publishCarousel throws with the fail reason on FAILED', async () => {
  const { pub } = build({ statuses: ['PROCESSING_UPLOAD', 'FAILED'], failReason: 'spam_risk' });
  await assert.rejects(() => pub.publishCarousel('acc1', ['u1', 'u2'], 'cap'), /TikTok publish failed.*spam_risk/);
});

test('publishCarousel throws on poll timeout (never completes)', async () => {
  const { pub } = build({ statuses: ['PROCESSING_UPLOAD'] });
  await assert.rejects(() => pub.publishCarousel('acc1', ['u1', 'u2'], 'cap'), /timed out/i);
});

test('publishCarousel propagates a token error before init', async () => {
  const { pub, calls } = build({ tokenThrow: 'inactive' });
  await assert.rejects(() => pub.publishCarousel('acc1', ['u1', 'u2'], 'cap'), /inactive/);
  assert.equal(calls.init, null);
});
