import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from './safe-equal';

test('safeEqual: identical strings are equal', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('ключ-🔑', 'ключ-🔑'), true);
});

test('safeEqual: different strings of the same length are not equal', () => {
  assert.equal(safeEqual('secret', 'secreT'), false);
});

test('safeEqual: different lengths are not equal (and do not throw)', () => {
  assert.equal(safeEqual('secret', 'secret-but-longer'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('safeEqual: non-string inputs are never equal', () => {
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual(null, 'x'), false);
  assert.equal(safeEqual('x', ['x'] as unknown as string), false);
});
