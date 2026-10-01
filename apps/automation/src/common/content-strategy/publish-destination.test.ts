import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingPostedKey } from './publish-destination';

test('bindingPostedKey mirrors DestinationResolver postedKey values', () => {
  assert.equal(bindingPostedKey('telegram', null, null, null), 'TELEGRAM');
  assert.equal(bindingPostedKey('instagram', 'instagram', 'a1', null), 'IG:a1');
  assert.equal(bindingPostedKey('facebook', null, 'a2', null), 'FB:a2');
  assert.equal(bindingPostedKey('threads', 'threads', 'a3', null), 'TH:a3');
  assert.equal(bindingPostedKey('tiktok', null, null, 't1'), 'TT:t1');
  assert.equal(bindingPostedKey('instagram', null, null, null), null);
  assert.equal(bindingPostedKey('tiktok', null, null, null), null);
});
