import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException, HttpStatus } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';

function ctxFor(ip: string) {
  const req: any = { ip, socket: { remoteAddress: ip } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

function makeGuard(limit = 10, windowMs = 60_000) {
  let now = 1_000_000;
  const guard = new RateLimitGuard({ limit, windowMs, now: () => now });
  return { guard, advance: (ms: number) => { now += ms; } };
}

function isTooMany(e: unknown): boolean {
  return e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS;
}

test('allows up to 10 requests per minute from one IP, rejects the 11th with 429', () => {
  const { guard } = makeGuard();
  for (let i = 0; i < 10; i++) assert.equal(guard.canActivate(ctxFor('1.2.3.4')), true);
  assert.throws(() => guard.canActivate(ctxFor('1.2.3.4')), isTooMany);
});

test('buckets are per IP', () => {
  const { guard } = makeGuard(2);
  guard.canActivate(ctxFor('1.1.1.1'));
  guard.canActivate(ctxFor('1.1.1.1'));
  assert.throws(() => guard.canActivate(ctxFor('1.1.1.1')), isTooMany);
  assert.equal(guard.canActivate(ctxFor('2.2.2.2')), true);
});

test('sliding window: old hits expire after windowMs', () => {
  const { guard, advance } = makeGuard(2, 60_000);
  guard.canActivate(ctxFor('1.1.1.1'));        // t=0
  advance(30_000);
  guard.canActivate(ctxFor('1.1.1.1'));        // t=30s
  assert.throws(() => guard.canActivate(ctxFor('1.1.1.1')), isTooMany);
  advance(30_001);                             // first hit (t=0) has left the window
  assert.equal(guard.canActivate(ctxFor('1.1.1.1')), true);
  assert.throws(() => guard.canActivate(ctxFor('1.1.1.1')), isTooMany);
});

test('rejected requests do not extend the lockout', () => {
  const { guard, advance } = makeGuard(1, 60_000);
  guard.canActivate(ctxFor('1.1.1.1'));
  for (let i = 0; i < 5; i++) {
    advance(10_000);
    assert.throws(() => guard.canActivate(ctxFor('1.1.1.1')), isTooMany);
  }
  advance(10_001);                             // 60s after the only accepted hit
  assert.equal(guard.canActivate(ctxFor('1.1.1.1')), true);
});
