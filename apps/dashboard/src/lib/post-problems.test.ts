// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B4: the composer's client-side checks, and when the form shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitFor, postProblems, shownProblems, visibleLen, type PostField } from './post-problems';
import type { ComposedPostInput } from '../api/types';

const NOW = Date.parse('2026-10-29T09:00:00Z');

const post = (over: Partial<ComposedPostInput> = {}): ComposedPostInput => ({
  channelId: 'c1', sender: 'bot', botId: 'b1', text: 'Hello', mediaType: 'none', mediaUrl: null, mediaPlacement: 'below', buttons: [],
  scheduledAt: '2026-10-30T10:00:00.000Z', ...over,
});

const fields = (p: ComposedPostInput) => postProblems(p, NOW).map((x) => x.field);

test('a valid post has no problems; a blank one lists every field that needs an answer', () => {
  assert.deepEqual(postProblems(post(), NOW), []);
  assert.deepEqual(fields(post({ channelId: '', botId: null, text: '', scheduledAt: '' })), ['channel', 'bot', 'text', 'time']);
});

test('the time must be a real instant in the future', () => {
  assert.deepEqual(postProblems(post({ scheduledAt: '2026-10-29T08:59:00Z' }), NOW), [{ field: 'time', message: 'Publish time must be in the future' }]);
  assert.deepEqual(postProblems(post({ scheduledAt: '2026-10-29T09:00:00Z' }), NOW).map((p) => p.field), ['time']);
  assert.deepEqual(fields(post({ scheduledAt: 'garbage' })), ['time']);
});

test('text: empty only counts without media and without buttons; the limit follows the sender and the media', () => {
  assert.deepEqual(fields(post({ text: '<b></b>' })), ['text']);
  assert.deepEqual(fields(post({ text: '', mediaType: 'photo', mediaUrl: 'https://x.test/a.jpg' })), []);
  assert.deepEqual(fields(post({ text: '', buttons: [{ buttons: [{ label: 'Go', url: 'https://x.test' }] }] })), []);
  assert.equal(limitFor('bot', 'none'), 4096);
  assert.equal(limitFor('bot', 'photo'), 1024);
  assert.equal(limitFor('mtproto_user', 'video'), 2048);
  assert.deepEqual(fields(post({ text: 'x'.repeat(1025), mediaType: 'photo', mediaUrl: 'https://x.test/a.jpg' })), ['text']);
  assert.deepEqual(fields(post({ text: 'x'.repeat(1025), mediaType: 'photo', mediaUrl: 'https://x.test/a.jpg', sender: 'mtproto_user', botId: null })), []);
  assert.equal(visibleLen('<b>ab</b> <a href="https://x.test">c</a>'), 4);
});

test('media needs an http(s) URL', () => {
  assert.deepEqual(fields(post({ mediaType: 'photo', mediaUrl: null })), ['media']);
  assert.deepEqual(fields(post({ mediaType: 'video', mediaUrl: 'ftp://x.test/a.mp4' })), ['media']);
  assert.deepEqual(fields(post({ mediaType: 'video', mediaUrl: 'HTTPS://x.test/a.mp4' })), []);
});

test('buttons: a label and an http(s) link each; a long caption cannot share a post with buttons', () => {
  const ok = { buttons: [{ label: 'Go', url: 'https://x.test' }] };
  assert.deepEqual(fields(post({ buttons: [ok] })), []);
  assert.deepEqual(fields(post({ buttons: [{ buttons: [{ label: ' ', url: 'https://x.test' }] }] })), ['buttons']);
  assert.deepEqual(fields(post({ buttons: [{ buttons: [{ label: 'Go', url: 'x.test' }] }] })), ['buttons']);
  const caption = post({ buttons: [ok], mediaType: 'photo', mediaUrl: 'https://x.test/a.jpg', mediaPlacement: 'above', text: 'x'.repeat(1030), sender: 'mtproto_user', botId: null });
  assert.deepEqual(fields(caption), ['buttons']);
});

test('the form shows a field\'s problems after the owner left it, and everything after a submit', () => {
  const problems = postProblems(post({ channelId: '', text: '', scheduledAt: '' }), NOW);
  const none = new Set<PostField>();
  assert.deepEqual(shownProblems(problems, false, none), []);
  assert.deepEqual(shownProblems(problems, false, new Set<PostField>(['text'])).map((p) => p.field), ['text']);
  assert.deepEqual(shownProblems(problems, true, none).map((p) => p.field), ['channel', 'text', 'time']);
});
