import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimiter, LimiterOptions } from './login-limiter';
import { FakeRedis } from './testing/fakes';

function setup(opts: LimiterOptions = {}, withRedis = true) {
  let now = 1_000_000;
  const clock = () => now;
  const redis = new FakeRedis(clock);
  const warnings: string[] = [];
  const limiter = new LoginLimiter(withRedis ? redis : null, { now: clock, warn: (m) => warnings.push(m), redisTimeoutMs: 20, ...opts });
  return { limiter, redis, warnings, advance: (ms: number) => { now += ms; } };
}

/** Both backends must enforce the same rules. */
for (const backend of ['redis', 'memory'] as const) {
  const make = (opts: LimiterOptions = {}) => {
    const s = setup(opts);
    if (backend === 'memory') s.redis.mode = 'throw';
    return s;
  };

  test(`[${backend}] allows 10 attempts per minute per IP, rejects the 11th with rate_limited + retry-after`, async () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 10; i++) { assert.deepEqual(await limiter.hit('1.2.3.4'), { ok: true }); advance(1000); }
    const v = await limiter.hit('1.2.3.4');
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.code === 'rate_limited' && v.retryAfterSec === 50);
    assert.deepEqual(await limiter.hit('5.6.7.8'), { ok: true }, 'buckets are per IP');
  });

  test(`[${backend}] sliding window: old hits expire; rejected attempts do not extend the wait`, async () => {
    const { limiter, advance } = make({ limit: 2 });
    await limiter.hit('1.1.1.1');            // t=0
    advance(30_000);
    await limiter.hit('1.1.1.1');            // t=30s
    for (let i = 0; i < 3; i++) { advance(5_000); assert.equal((await limiter.hit('1.1.1.1')).ok, false); }
    advance(15_001);                          // t=60.001s: the t=0 hit left the window
    assert.equal((await limiter.hit('1.1.1.1')).ok, true);
    assert.equal((await limiter.hit('1.1.1.1')).ok, false);
  });

  test(`[${backend}] 20 failures in an hour lock the IP out for an hour`, async () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 19; i++) assert.equal((await limiter.fail('9.9.9.9')).lockedNow, false);
    assert.equal((await limiter.fail('9.9.9.9')).lockedNow, true);
    const v = await limiter.hit('9.9.9.9');
    assert.ok(!v.ok && v.code === 'locked_out' && v.retryAfterSec === 3600);
    assert.equal((await limiter.hit('9.9.9.8')).ok, true, 'other IPs are not locked');
    advance(3_600_001);
    assert.equal((await limiter.hit('9.9.9.9')).ok, true);
  });

  test(`[${backend}] the failure count resets after an hour`, async () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 19; i++) await limiter.fail('9.9.9.9');
    advance(3_600_001);
    assert.equal((await limiter.fail('9.9.9.9')).lockedNow, false);
  });

  test(`[${backend}] global burst: the 50th failure in an hour alerts once and locks nobody`, async () => {
    const { limiter } = make();
    const bursts: number[] = [];
    for (let i = 0; i < 60; i++) {
      const o = await limiter.fail(`10.0.${i}.1`);          // spread over IPs: no per-IP lockout
      if (o.globalBurst) bursts.push(i + 1);
      assert.equal(o.lockedNow, false);
    }
    assert.deepEqual(bursts, [50]);
    assert.equal((await limiter.hit('10.0.0.1')).ok, true);
  });
}

test('Redis is used while healthy; nothing is kept in memory', async () => {
  const { limiter, redis, warnings } = setup();
  await limiter.hit('1.2.3.4');
  assert.ok(redis.calls > 0);
  assert.deepEqual(warnings, []);
});

test('Redis outage mid-way falls back to memory with a (throttled) warning, never fail-open', async () => {
  const { limiter, redis, warnings } = setup({ limit: 3 });
  await limiter.hit('1.2.3.4');
  redis.mode = 'throw';
  for (let i = 0; i < 3; i++) assert.equal((await limiter.hit('1.2.3.4')).ok, true);
  assert.equal((await limiter.hit('1.2.3.4')).ok, false, 'memory window still limits');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /in-memory/);
});

test('a hanging Redis (disconnected ioredis queues forever) times out to memory', async () => {
  const { limiter, redis, warnings } = setup();
  redis.mode = 'hang';
  assert.equal((await limiter.hit('1.2.3.4')).ok, true);
  assert.match(warnings[0], /timeout/);
});

test('a client that is not ready is not even tried', async () => {
  const { limiter, redis, warnings } = setup();
  redis.status = 'reconnecting';
  assert.equal((await limiter.hit('1.2.3.4')).ok, true);
  assert.equal(redis.calls, 0);
  assert.match(warnings[0], /not ready/);
});

test('no Redis at all: memory limiter', async () => {
  const { limiter } = setup({ limit: 1 }, false);
  assert.equal((await limiter.hit('1.2.3.4')).ok, true);
  assert.equal((await limiter.hit('1.2.3.4')).ok, false);
});
