import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPost } from './lint-post';
import { makeCard, makeSpec } from './testing/fixtures';

const codes = (spec: any, card = makeCard()) => lintPost(spec, card).errors.map((e) => e.code);

test('green case', () => {
  const r = lintPost(makeSpec(), makeCard());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('format rules', () => {
  assert.ok(codes(makeSpec({ format: 'video' })).includes('format_not_supported_yet'));
  assert.ok(codes(makeSpec(), makeCard({ formats: { text: 1 } })).includes('format_not_allowed'));
  assert.ok(!codes(makeSpec(), makeCard({ formats: { text: 1, photo: 0.1 } })).includes('format_not_allowed'));
});

test('attribution', () => {
  assert.ok(codes(makeSpec({ source: undefined })).includes('source_required'));
  assert.ok(codes(makeSpec({ origin: 'library', source: undefined })).includes('library_ref_required'));
  assert.ok(!codes(makeSpec({ origin: 'library', source: undefined, library_ref: 'library://recipes/5' })).includes('library_ref_required'));
});

test('hashtags', () => {
  assert.ok(codes(makeSpec({ hashtags: ['мода'] })).includes('hashtag_not_in_vocabulary'));
  assert.ok(codes(makeSpec({ hashtags: ['кос мос'] })).includes('hashtag_format'));
  assert.ok(codes(makeSpec({ hashtags: [] })).includes('hashtag_count'));
  assert.ok(codes(makeSpec({ hashtags: ['космос', 'nasa', 'фото', 'космос'] })).includes('hashtag_count'));
  assert.ok(codes(makeSpec({ hashtags: ['космос', '#Космос'] })).includes('hashtag_duplicate'));
  assert.equal(lintPost(makeSpec({ hashtags: ['#NASA'] }), makeCard()).ok, true);
});

test('media counts and album buttons', () => {
  assert.ok(codes(makeSpec({ media: [] })).includes('media_count'));
  assert.ok(codes(makeSpec({ format: 'album' })).includes('media_count'));
  const album = makeSpec({ format: 'album', media: [{ url: 'https://a.example/1.jpg' }, { url: 'https://a.example/2.jpg' }], cta: { url: 'https://x.example', label: 'Go' } });
  assert.ok(codes(album).includes('album_with_buttons'));
});

test('poll and quiz', () => {
  assert.ok(codes(makeSpec({ format: 'poll', media: [] })).includes('poll_missing'));
  const quiz = (poll: any) => makeSpec({ format: 'quiz', media: [], body: [], hashtags: [], poll });
  assert.ok(codes(quiz({ question: 'Q?', options: ['a', 'b'] })).includes('quiz_correct_index'));
  assert.ok(codes(quiz({ question: 'Q?', options: ['a', 'b'], correct_index: 5 })).includes('quiz_correct_index'));
  assert.ok(codes(quiz({ question: 'Q?', options: ['a', 'A'], correct_index: 0 })).includes('poll_options'));
  assert.equal(lintPost(quiz({ question: 'Яка найбільша планета?', options: ['Марс', 'Юпітер'], correct_index: 1 }), makeCard()).ok, true);
});

test('length', () => {
  assert.ok(codes(makeSpec({ format: 'text', media: [], body: [{ type: 'p', text: 'а'.repeat(1500) }, { type: 'p', text: 'б'.repeat(1500) }, { type: 'p', text: 'в'.repeat(1500) }] })).includes('too_long'));
  const album = makeSpec({ format: 'album', media: [{ url: 'https://a.example/1.jpg' }, { url: 'https://a.example/2.jpg' }], body: [{ type: 'p', text: 'а'.repeat(1100) }] });
  assert.ok(codes(album).includes('too_long'));
});

test('language, banned terms, emoji, empty body', () => {
  assert.ok(codes(makeSpec({ body: [{ type: 'p', text: 'This is an English post about the ring nebula and telescopes.' }] })).includes('not_ukrainian'));
  assert.ok(codes(makeSpec({ body: [{ type: 'p', text: 'Варто зазначити, що телескоп працює.' }] })).includes('banned_term'));
  assert.ok(codes(makeSpec(), makeCard({ bannedTerms: ['туманність'] })).includes('banned_term'));
  assert.ok(codes(makeSpec({ body: [{ type: 'p', text: 'Зоря 🌟🌟🌟🌟 сяє яскраво над містом сьогодні' }] })).includes('emoji_policy'));
  assert.ok(codes(makeSpec({ body: [{ type: 'p', text: 'Зоря 🌟 сяє яскраво над містом сьогодні' }] }), makeCard({ emojiPolicy: 'none' })).includes('emoji_policy'));
  assert.ok(codes(makeSpec({ body: [] })).includes('empty_body'));
});

test('warnings do not fail', () => {
  const r = lintPost(makeSpec({ body: [{ type: 'p', text: 'Звичайний абзац українською про космос і зорі.' }] }), makeCard());
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'lead_missing'));
});
