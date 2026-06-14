import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideKey, slideContentType } from './slide-hosting.util';

test('slideKey appends slide-<n>.png with 1-based index', () => {
  assert.equal(slideKey('carousel/r1/abc', 0), 'carousel/r1/abc/slide-1.png');
  assert.equal(slideKey('carousel/r1/abc', 2), 'carousel/r1/abc/slide-3.png');
});

test('slideKey normalizes a trailing slash on the prefix', () => {
  assert.equal(slideKey('carousel/r1/abc/', 0), 'carousel/r1/abc/slide-1.png');
});

test('slideContentType is image/png', () => {
  assert.equal(slideContentType(), 'image/png');
});
