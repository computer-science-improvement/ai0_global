import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCarouselSize, joinChildren, fbAttachedMedia } from './meta-carousel';

test('assertCarouselSize throws below 2', () => {
  assert.throws(() => assertCarouselSize(1, 10, 'instagram'), /instagram.*2.*10.*got 1/i);
  assert.throws(() => assertCarouselSize(0, 10, 'instagram'), /got 0/i);
});

test('assertCarouselSize throws above max', () => {
  assert.throws(() => assertCarouselSize(11, 10, 'instagram'), /got 11/i);
});

test('assertCarouselSize accepts an in-range count', () => {
  assert.doesNotThrow(() => assertCarouselSize(3, 10, 'instagram'));
  assert.doesNotThrow(() => assertCarouselSize(2, 10, 'instagram'));
  assert.doesNotThrow(() => assertCarouselSize(10, 10, 'instagram'));
});

test('joinChildren comma-joins ids', () => {
  assert.equal(joinChildren(['a', 'b', 'c']), 'a,b,c');
});

test('fbAttachedMedia builds the media_fbid JSON array', () => {
  assert.equal(fbAttachedMedia(['1', '2']), '[{"media_fbid":"1"},{"media_fbid":"2"}]');
});
