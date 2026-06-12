import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPermanentMetaMediaError } from './meta-graph.util';

test('permanent media errors are recognized', () => {
  for (const m of [
    'The aspect ratio is not supported.',
    'Unsupported image format',
    'Invalid image: dimensions too large',
    'Media type not supported',
    'image resolution exceeds the limit',
    'The image is too tall',
  ]) {
    assert.equal(isPermanentMetaMediaError(m), true, m);
  }
});

test('transient errors are NOT treated as permanent', () => {
  for (const m of [
    'connect ETIMEDOUT',
    'socket hang up',
    'Application request limit reached',
    'An unexpected error has occurred. Please retry your request later.',
    '',
  ]) {
    assert.equal(isPermanentMetaMediaError(m), false, m);
  }
});
