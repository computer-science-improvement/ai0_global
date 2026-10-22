import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errText } from './err-text';

test('errText: message, then code, cause code, name, then the value', () => {
  assert.equal(errText(new Error('boom')), 'boom');
  assert.equal(errText(Object.assign(new Error(''), { code: 'ECONNRESET' })), 'ECONNRESET');
  assert.equal(errText(Object.assign(new Error(''), { cause: { code: 'ETIMEDOUT' } })), 'ETIMEDOUT');
  assert.equal(errText(new TypeError('')), 'TypeError');
  assert.equal(errText({ message: '  ' }), '[object Object]');
  assert.equal(errText('plain'), 'plain');
  assert.equal(errText(''), 'unknown error');
  assert.equal(errText(undefined), 'unknown error');
  assert.equal(errText(42), '42');
});
