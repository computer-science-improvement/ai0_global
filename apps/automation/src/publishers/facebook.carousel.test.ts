import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookPublisher } from './facebook.publisher';
import { fbAttachedMedia } from './meta-carousel';
import type { PostPayload } from '../common/types';

function fakeConfig() { return { get: () => undefined } as any; }

function makeRecorder() {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  return {
    calls,
    post: async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/feed')) return { id: 'fb_post', post_id: 'fb_post' };
      return { id: `fb_photo_${calls.length}` };
    },
  };
}

class TestFb extends FacebookPublisher {
  constructor(private readonly rec: any) { super(fakeConfig()); }
  protected post(url: string, params: Record<string, string>) { return this.rec.post(url, params); }
}

const PAYLOAD: PostPayload = { text: 'Hello', tags: ['food'], source: '' };
const TARGET = { id: 'PAGE123', token: 'tok' };

test('facebook publishCarousel uploads unpublished photos then a feed post with attached_media', async () => {
  const rec = makeRecorder();
  const fb = new TestFb(rec);

  const id = await fb.publishCarousel(PAYLOAD, ['u1', 'u2', 'u3'], TARGET);

  assert.equal(rec.calls.length, 4); // 3 photos + 1 feed

  const photos = rec.calls.slice(0, 3);
  for (const [i, c] of photos.entries()) {
    assert.ok(c.url.endsWith('/PAGE123/photos'), `photo ${i} hits /photos`);
    assert.equal(c.params.url, ['u1', 'u2', 'u3'][i]);
    assert.equal(c.params.published, 'false');
    assert.equal(c.params.access_token, 'tok');
  }

  const feed = rec.calls[3];
  assert.ok(feed.url.endsWith('/PAGE123/feed'));
  assert.equal(feed.params.message, 'Hello'); // FB maxTags 0 → no hashtags
  assert.equal(feed.params.attached_media, fbAttachedMedia(['fb_photo_1', 'fb_photo_2', 'fb_photo_3']));

  assert.equal(id, 'fb_post');
});

test('facebook publishCarousel rejects when a photo upload fails (no feed post)', async () => {
  const calls: any[] = [];
  class FailFb extends FacebookPublisher {
    constructor() { super(fakeConfig()); }
    protected post(url: string, params: Record<string, string>) {
      calls.push({ url, params });
      if (url.endsWith('/photos') && calls.length === 2) throw new Error('bad photo');
      return Promise.resolve({ id: 'x' });
    }
  }
  await assert.rejects(() => new FailFb().publishCarousel(PAYLOAD, ['u1', 'u2', 'u3'], TARGET), /bad photo/);
  // only the 2 photo attempts happened — no feed post
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(c => c.url.endsWith('/feed')));
});
