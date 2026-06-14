import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramPublisher } from './instagram.publisher';
import type { PostPayload } from '../common/types';

function fakeConfig() { return { get: () => undefined } as any; }

// Records each graph call and returns canned ids: item containers ig_item_N, parent
// ig_parent, publish ig_published.
function makeRecorder() {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  return {
    calls,
    post: async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/media_publish')) return { id: 'ig_published' };
      if (params.media_type === 'CAROUSEL') return { id: 'ig_parent' };
      return { id: `ig_item_${calls.length}` };
    },
  };
}

class TestIg extends InstagramPublisher {
  constructor(private readonly rec: any) { super(fakeConfig()); }
  protected post(url: string, params: Record<string, string>) { return this.rec.post(url, params); }
}

const PAYLOAD: PostPayload = { text: 'Hello', tags: ['food'], source: '' };
const TARGET = { id: 'IG123', token: 'tok' };

test('instagram publishCarousel creates items, a CAROUSEL parent, then publishes', async () => {
  const rec = makeRecorder();
  const ig = new TestIg(rec);

  const id = await ig.publishCarousel(PAYLOAD, ['u1', 'u2', 'u3'], TARGET);

  // 3 item containers + 1 parent + 1 publish = 5 calls
  assert.equal(rec.calls.length, 5);

  const items = rec.calls.slice(0, 3);
  for (const [i, c] of items.entries()) {
    assert.ok(c.url.endsWith('/IG123/media'), `item ${i} hits /media`);
    assert.equal(c.params.image_url, ['u1', 'u2', 'u3'][i]);
    assert.equal(c.params.is_carousel_item, 'true');
    assert.equal(c.params.access_token, 'tok');
  }

  const parent = rec.calls[3];
  assert.ok(parent.url.endsWith('/IG123/media'));
  assert.equal(parent.params.media_type, 'CAROUSEL');
  assert.equal(parent.params.children, 'ig_item_1,ig_item_2,ig_item_3');
  // buildCaption('Hello', ['food'], { maxLen: 2200, maxTags: 30 }) appends the hashtag.
  assert.equal(parent.params.caption, 'Hello\n\n#food');

  const pub = rec.calls[4];
  assert.ok(pub.url.endsWith('/IG123/media_publish'));
  assert.equal(pub.params.creation_id, 'ig_parent');

  assert.equal(id, 'ig_published');
});

test('instagram publishCarousel rejects when an item container fails (no parent/publish)', async () => {
  const calls: any[] = [];
  class FailIg extends InstagramPublisher {
    constructor() { super(fakeConfig()); }
    protected post(url: string, params: Record<string, string>) {
      calls.push({ url, params });
      if (params.is_carousel_item === 'true' && calls.length === 2) throw new Error('bad media');
      return Promise.resolve({ id: 'x' });
    }
  }
  await assert.rejects(() => new FailIg().publishCarousel(PAYLOAD, ['u1', 'u2'], TARGET), /bad media/);
  // only the 2 item attempts happened — no CAROUSEL parent, no publish
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(c => c.params.media_type === 'CAROUSEL'));
});
