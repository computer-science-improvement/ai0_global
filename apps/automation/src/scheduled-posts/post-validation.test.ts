// post-validation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleLength, captionLimitFor, validateComposedPost } from './post-validation';
import type { ComposedPost } from './scheduled-posts.types';

const base: ComposedPost = {
  channelId: 'c1', sender: 'bot', botId: 'b1', text: 'hi',
  mediaType: 'none', mediaUrl: null, mediaPlacement: 'above',
  buttons: [], scheduledAt: '2099-01-01T00:00:00.000Z',
};

test('visibleLength strips HTML tags', () => {
  assert.equal(visibleLength('<b>ab</b><a href="x">cd</a>'), 4);
});

test('captionLimitFor: bot photo=1024, mtproto photo=2048, text=4096', () => {
  assert.equal(captionLimitFor('bot', 'photo'), 1024);
  assert.equal(captionLimitFor('mtproto_user', 'photo'), 2048);
  assert.equal(captionLimitFor('bot', 'none'), 4096);
});

test('buttons force bot: mtproto_user + buttons → error', () => {
  const r = validateComposedPost({ ...base, sender: 'mtproto_user',
    buttons: [{ buttons: [{ label: 'x', url: 'https://a' }] }] });
  assert.ok(r.errors.some(e => e.includes('buttons')));
});

test('bot photo caption >1024 above → error (needs mtproto_user)', () => {
  const r = validateComposedPost({ ...base, mediaType: 'photo', mediaUrl: 'https://i',
    mediaPlacement: 'above', text: 'x'.repeat(1025) });
  assert.ok(r.errors.some(e => e.includes('1024')));
});

test('valid bot text post passes', () => {
  assert.deepEqual(validateComposedPost(base).errors, []);
});

test('photo requires mediaUrl', () => {
  const r = validateComposedPost({ ...base, mediaType: 'photo', mediaUrl: null });
  assert.ok(r.errors.some(e => e.includes('media URL')));
});

test('past scheduled time → error', () => {
  const r = validateComposedPost({ ...base, scheduledAt: '2000-01-01T00:00:00.000Z' });
  assert.ok(r.errors.some(e => e.includes('future')));
});

test('mtproto_user + media below text → error', () => {
  const r = validateComposedPost({ ...base, sender: 'mtproto_user', botId: null,
    mediaType: 'photo', mediaUrl: 'https://i', mediaPlacement: 'below' });
  assert.ok(r.errors.some(e => e.includes('під текстом')));
});

test('mtproto_user + media above text → no placement error', () => {
  const r = validateComposedPost({ ...base, sender: 'mtproto_user', botId: null,
    mediaType: 'photo', mediaUrl: 'https://i', mediaPlacement: 'above' });
  assert.ok(!r.errors.some(e => e.includes('під текстом')));
});

test('button url must be http(s)', () => {
  const r = validateComposedPost({ ...base, buttons: [{ buttons: [{ label: 'x', url: 'ftp://a' }] }] });
  assert.ok(r.errors.some(e => e.includes('url')));
});
