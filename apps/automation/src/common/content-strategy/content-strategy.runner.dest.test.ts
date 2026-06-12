import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentStrategyRunner } from './content-strategy.runner';
import type { PublishDestination } from './publish-destination';

function makeThrottle() {
  const calls: { lock: string[]; release: string[] } = { lock: [], release: [] };
  return {
    calls,
    tryLock: (key: string) => { calls.lock.push(key); return true; },
    logCooldown: () => {},
    remainingMs: () => 0,
    releaseLock: (key: string) => { calls.release.push(key); },
  };
}

function runner(throttle: any) {
  // Constructor order: reviewer, dedup, images, telegram, notifier, throttle,
  // publications, crossPost. Only throttle + the strategy are exercised on the
  // custom-execute path; pass empty objects for the rest.
  return new ContentStrategyRunner(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    throttle as any, {} as any, {} as any,
  );
}

test('custom execute receives the destination; throttle keyed by throttleKey', async () => {
  const throttle = makeThrottle();
  const r = runner(throttle);
  let got: PublishDestination | undefined;
  const strategy: any = {
    type: 'recipes',
    execute: async (_c: string, _p: any, dest?: PublishDestination) => { got = dest; },
  };
  const dest: PublishDestination = {
    platform: 'instagram', targetId: 'ig-target', token: 't',
    metaAccountId: 'acct-1', postedKey: 'IG:acct-1', throttleKey: 'meta:acct-1',
  };
  await r.run(strategy, '', {}, 'recipes-ig', dest);
  assert.equal(got?.postedKey, 'IG:acct-1');
  assert.deepEqual(throttle.calls.lock, ['meta:acct-1']);
  // No publish happened (execute is a no-op, remainingMs=0) → lock released.
  assert.deepEqual(throttle.calls.release, ['meta:acct-1']);
});

test('without a destination, throttle falls back to channelId', async () => {
  const throttle = makeThrottle();
  const r = runner(throttle);
  const strategy: any = { type: 'recipes', execute: async () => {} };
  await r.run(strategy, '@ai0_recipes', {}, 'recipes-tg');
  assert.deepEqual(throttle.calls.lock, ['@ai0_recipes']);
  assert.deepEqual(throttle.calls.release, ['@ai0_recipes']);
});
