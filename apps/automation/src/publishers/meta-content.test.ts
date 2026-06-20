// meta-content.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToPlainText, toHashtag, buildCaption } from './meta-content';

test('htmlToPlainText strips tags and preserves anchor url as "text (url)"', () => {
  assert.equal(htmlToPlainText('<b>Hi</b> <a href="https://x">there</a>'), 'Hi there (https://x)');
});

test('htmlToPlainText keeps source attribution url for Meta cross-posts', () => {
  assert.equal(
    htmlToPlainText('Новина текст\n\n<a href="https://theverge.com/a">Джерело</a>'),
    'Новина текст\n\nДжерело (https://theverge.com/a)',
  );
});

test('htmlToPlainText does not double-print when anchor text already is the url', () => {
  assert.equal(htmlToPlainText('<a href="https://x">https://x</a>'), 'https://x');
});

test('htmlToPlainText converts <br> and </p> to newlines, decodes entities', () => {
  assert.equal(htmlToPlainText('a<br>b'), 'a\nb');
  assert.equal(htmlToPlainText('<p>a</p><p>b</p>'), 'a\n\nb');
  assert.equal(htmlToPlainText('Tom &amp; Jerry &#39;99'), "Tom & Jerry '99");
});

test('htmlToPlainText collapses 3+ newlines to 2', () => {
  assert.equal(htmlToPlainText('a<br><br><br><br>b'), 'a\n\nb');
});

test('toHashtag keeps unicode letters/numbers, drops punctuation/spaces', () => {
  assert.equal(toHashtag('новини'), '#новини');
  assert.equal(toHashtag('tech news!'), '#technews');
  assert.equal(toHashtag('  '), null);
});

test('buildCaption appends up to maxTags unique hashtags', () => {
  const c = buildCaption('Body', ['a', 'a', 'b', 'c'], { maxLen: 2200, maxTags: 2 });
  assert.equal(c, 'Body\n\n#a #b');
});

test('buildCaption with maxTags=0 omits hashtags (Threads)', () => {
  assert.equal(buildCaption('Body', ['a', 'b'], { maxLen: 500, maxTags: 0 }), 'Body');
});

test('buildCaption truncates to maxLen with ellipsis', () => {
  const c = buildCaption('x'.repeat(600), [], { maxLen: 500, maxTags: 0 });
  assert.equal(c.length, 500);
  assert.ok(c.endsWith('…'));
});

test('buildCaption strips HTML before counting', () => {
  assert.equal(buildCaption('<b>hi</b>', [], { maxLen: 2200, maxTags: 0 }), 'hi');
});
