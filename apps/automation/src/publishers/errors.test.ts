import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelPausedError, isChannelPausedError } from './errors';

test('ChannelPausedError is detected by name (survives lost prototypes)', () => {
  assert.equal(isChannelPausedError(new ChannelPausedError('@c')), true);
  const plain = Object.assign(new Error('x'), { name: 'ChannelPausedError' });
  assert.equal(isChannelPausedError(plain), true);
  assert.equal(isChannelPausedError(new Error('x')), false);
});
