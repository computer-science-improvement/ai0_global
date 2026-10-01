import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostingThrottleService, LOCK_TTL_MS } from './posting-throttle.service';

function svc() {
  // No settings/config injected → cooldown falls back to the 20-min default.
  return new PostingThrottleService(undefined, undefined);
}

test('tryLock: second caller is refused while the lock is held', () => {
  const t = svc();
  assert.equal(t.tryLock('@c'), true);
  assert.equal(t.tryLock('@c'), false);
  t.releaseLock('@c');
  assert.equal(t.tryLock('@c'), true);
});

test('tryLock: a lock older than the TTL is treated as leaked and can be re-taken', () => {
  const t = svc();
  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    assert.equal(t.tryLock('@c'), true);
    now += LOCK_TTL_MS - 1;
    assert.equal(t.tryLock('@c'), false, 'still held just before the TTL');
    now += 2;
    assert.equal(t.tryLock('@c'), true, 'expired lock is re-acquirable');
  } finally {
    Date.now = realNow;
  }
});

test('LOCK_TTL_MS is 10 minutes', () => {
  assert.equal(LOCK_TTL_MS, 10 * 60_000);
});

test('recordPublish frees the lock and starts the cooldown', () => {
  const t = svc();
  assert.equal(t.tryLock('@c'), true);
  t.recordPublish('@c');
  assert.ok(t.remainingMs('@c') > 0);
  assert.equal(t.tryLock('@c'), false, 'cooldown blocks the next lock');
});
