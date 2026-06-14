import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublisherDispatcher } from './publisher-dispatcher.service';
import type { PostPayload } from '../common/types';

function stub(platform: string) {
  const seen: any = {};
  return {
    platform,
    publish: async () => 'single',
    publishCarousel: async (payload: PostPayload, imageUrls: string[], target: any) => {
      seen.payload = payload; seen.imageUrls = imageUrls; seen.target = target;
      return `${platform}_carousel`;
    },
    seen,
  } as any;
}

const PAYLOAD: PostPayload = { text: 'x', tags: [], source: '' };

test('dispatcher.publishCarousel routes to the platform publisher', async () => {
  const ig = stub('instagram'), fb = stub('facebook'), th = stub('threads');
  const d = new PublisherDispatcher(fb, ig, th);

  const id = await d.publishCarousel('instagram', PAYLOAD, ['u1', 'u2'], { id: 'X', token: 't' });
  assert.equal(id, 'instagram_carousel');
  assert.deepEqual(ig.seen.imageUrls, ['u1', 'u2']);
  assert.equal(ig.seen.target.id, 'X');
});

test('dispatcher.publishCarousel throws for an unknown platform', async () => {
  const ig = stub('instagram'), fb = stub('facebook'), th = stub('threads');
  const d = new PublisherDispatcher(fb, ig, th);
  await assert.rejects(
    () => d.publishCarousel('tiktok' as any, PAYLOAD, ['u1', 'u2'], { id: 'X' }),
    /No publisher for platform tiktok/,
  );
});
