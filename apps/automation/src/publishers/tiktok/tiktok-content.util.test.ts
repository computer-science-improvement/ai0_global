import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoPostBody, captionToTitleDescription, isComplete, isFailed } from './tiktok-content.util';

test('buildPhotoPostBody assembles a DIRECT_POST photo body', () => {
  const body = buildPhotoPostBody({
    imageUrls: ['u1', 'u2', 'u3'], title: 'Pommes', description: 'full caption',
    privacyLevel: 'SELF_ONLY',
  }) as any;
  assert.equal(body.post_mode, 'DIRECT_POST');
  assert.equal(body.media_type, 'PHOTO');
  assert.equal(body.source_info.source, 'PULL_FROM_URL');
  assert.deepEqual(body.source_info.photo_images, ['u1', 'u2', 'u3']);
  assert.equal(body.source_info.photo_cover_index, 0);
  assert.equal(body.post_info.title, 'Pommes');
  assert.equal(body.post_info.description, 'full caption');
  assert.equal(body.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(body.post_info.disable_comment, false);
});

test('buildPhotoPostBody honors a custom coverIndex', () => {
  const body = buildPhotoPostBody({
    imageUrls: ['u1', 'u2'], title: 't', description: 'd', privacyLevel: 'PUBLIC_TO_EVERYONE', coverIndex: 1,
  }) as any;
  assert.equal(body.source_info.photo_cover_index, 1);
});

test('buildPhotoPostBody throws on empty urls', () => {
  assert.throws(() => buildPhotoPostBody({ imageUrls: [], title: 't', description: 'd', privacyLevel: 'SELF_ONLY' }), /at least one image/i);
});

test('captionToTitleDescription splits first line as title (capped 90)', () => {
  const r = captionToTitleDescription('Pommes Anna\n\n🍽️ French\n\nгортай');
  assert.equal(r.title, 'Pommes Anna');
  assert.equal(r.description, 'Pommes Anna\n\n🍽️ French\n\nгортай');
});

test('captionToTitleDescription caps a long single-line title at 90 chars', () => {
  const long = 'x'.repeat(120);
  const r = captionToTitleDescription(long);
  assert.equal(r.title.length, 90);
  assert.equal(r.description, long);
});

test('status helpers classify TikTok statuses', () => {
  assert.equal(isComplete('PUBLISH_COMPLETE'), true);
  assert.equal(isComplete('PROCESSING_UPLOAD'), false);
  assert.equal(isFailed('FAILED'), true);
  assert.equal(isFailed('PUBLISH_COMPLETE'), false);
});
