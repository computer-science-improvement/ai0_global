import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowLimiter } from './sliding-window-limiter';

test('allows max hits per window per key, then refuses with a retry-after', () => {
  let t = 1_000_000;
  const l = new SlidingWindowLimiter(3, 60_000, () => t);
  assert.equal(l.hit('a').ok, true);
  assert.equal(l.hit('a').ok, true);
  assert.equal(l.hit('a').ok, true);
  const no = l.hit('a');
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterSec, 60);
  assert.equal(l.hit('b').ok, true, 'keys are independent');
  t += 60_001;
  assert.equal(l.hit('a').ok, true, 'the window slides');
});

test('the key map stays bounded under a flood of distinct keys', () => {
  const t = 5;
  const l = new SlidingWindowLimiter(1, 60_000, () => t, 100);
  for (let i = 0; i < 1000; i++) l.hit(`k${i}`);
  assert.ok(l.size <= 100);
});
