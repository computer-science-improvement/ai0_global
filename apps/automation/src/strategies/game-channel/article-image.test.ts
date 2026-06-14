import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPreloadImage } from './article-image';

test('extracts href from a preload image link', () => {
  const html = '<head><link rel="preload" as="image" href="https://cdn.pcgamer.com/hero.jpg"></head>';
  assert.equal(extractPreloadImage(html), 'https://cdn.pcgamer.com/hero.jpg');
});

test('handles reversed attribute order and extra attributes', () => {
  const html = '<link as="image" imagesrcset="x 1x" rel="preload" href="https://x/a.jpg" fetchpriority="high">';
  assert.equal(extractPreloadImage(html), 'https://x/a.jpg');
});

test('decodes &amp; in the href', () => {
  const html = '<link rel="preload" as="image" href="https://x/a.jpg?w=1&amp;h=2">';
  assert.equal(extractPreloadImage(html), 'https://x/a.jpg?w=1&h=2');
});

test('ignores non-image preloads and returns null when absent', () => {
  assert.equal(extractPreloadImage('<link rel="preload" as="font" href="https://x/f.woff2">'), null);
  assert.equal(extractPreloadImage('<p>no links</p>'), null);
  assert.equal(extractPreloadImage(''), null);
});

test('returns the first preload image when several exist', () => {
  const html =
    '<link rel="preload" as="image" href="https://x/first.jpg">' +
    '<link rel="preload" as="image" href="https://x/second.jpg">';
  assert.equal(extractPreloadImage(html), 'https://x/first.jpg');
});
