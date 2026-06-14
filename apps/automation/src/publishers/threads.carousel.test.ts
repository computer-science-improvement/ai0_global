import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadsPublisher } from './threads.publisher';
import type { PostPayload } from '../common/types';

function fakeConfig() { return { get: () => undefined } as any; }

function makeRecorder() {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  return {
    calls,
    post: async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/threads_publish')) return { id: 'th_published' };
      if (params.media_type === 'CAROUSEL') return { id: 'th_parent' };
      return { id: `th_item_${calls.length}` };
    },
  };
}

class TestTh extends ThreadsPublisher {
  constructor(private readonly rec: any) { super(fakeConfig()); }
  protected post(url: string, params: Record<string, string>) { return this.rec.post(url, params); }
}

const PAYLOAD: PostPayload = { text: 'Hello', tags: ['food'], source: '' };
const TARGET = { id: 'TH123', token: 'tok' };

test('threads publishCarousel creates IMAGE items, a CAROUSEL parent, then publishes', async () => {
  const rec = makeRecorder();
  const th = new TestTh(rec);

  const id = await th.publishCarousel(PAYLOAD, ['u1', 'u2', 'u3'], TARGET);

  assert.equal(rec.calls.length, 5);

  const items = rec.calls.slice(0, 3);
  for (const [i, c] of items.entries()) {
    assert.ok(c.url.endsWith('/TH123/threads'), `item ${i} hits /threads`);
    assert.equal(c.params.media_type, 'IMAGE');
    assert.equal(c.params.image_url, ['u1', 'u2', 'u3'][i]);
    assert.equal(c.params.is_carousel_item, 'true');
    assert.equal(c.params.access_token, 'tok');
  }

  const parent = rec.calls[3];
  assert.ok(parent.url.endsWith('/TH123/threads'));
  assert.equal(parent.params.media_type, 'CAROUSEL');
  assert.equal(parent.params.children, 'th_item_1,th_item_2,th_item_3');
  assert.equal(parent.params.text, 'Hello'); // Threads maxTags 0 → no hashtags appended

  const pub = rec.calls[4];
  assert.ok(pub.url.endsWith('/TH123/threads_publish'));
  assert.equal(pub.params.creation_id, 'th_parent');

  assert.equal(id, 'th_published');
});
