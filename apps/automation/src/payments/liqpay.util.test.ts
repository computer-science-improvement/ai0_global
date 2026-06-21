import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, encodeData, decodeData, verify } from './liqpay.util';

const KEY = 'test_private_key';

test('sign is deterministic for a fixed key+data', () => {
  const s1 = sign('DATA', KEY);
  const s2 = sign('DATA', KEY);
  assert.equal(s1, s2);
  assert.ok(s1.length > 0);
});

test('encodeData/decodeData round-trip JSON', () => {
  const params = { public_key: 'pk', amount: 100, order_id: 'o1' };
  const data = encodeData(params);
  assert.deepEqual(decodeData(data), params);
});

test('verify accepts a correct signature and rejects a tampered one', () => {
  const data = encodeData({ order_id: 'o1', status: 'success' });
  const good = sign(data, KEY);
  assert.equal(verify(data, good, KEY), true);
  assert.equal(verify(data, good + 'x', KEY), false);
  assert.equal(verify(data, sign(data, 'other_key'), KEY), false);
});
