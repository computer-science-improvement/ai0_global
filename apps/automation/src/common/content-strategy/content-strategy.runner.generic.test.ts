import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentStrategyRunner } from './content-strategy.runner';
import { PostingThrottleService } from '../../publishers/posting-throttle.service';
import { ChannelPausedError, isChannelPausedError } from '../../publishers/errors';

/** Real throttle (no settings → 20-min default cooldown) so lock state is observable. */
function throttle() {
  return new PostingThrottleService(undefined, undefined);
}

function deps(over: Partial<Record<string, any>> = {}) {
  const calls = { markPosted: [] as any[], markError: [] as any[], notifyFailed: [] as any[] };
  const d = {
    reviewer:     { review: async (t: string) => t },
    dedup:        {
      filterUnposted: async (items: any[]) => items,
      markPosted: async (...a: any[]) => { calls.markPosted.push(a); },
      markError:  async (...a: any[]) => { calls.markError.push(a); },
    },
    images:       { download: async () => null },
    telegram:     { publish: async () => '42', publishPrompt: async () => '42' },
    notifier:     {
      notifyPublished: async () => {},
      notifyFailed: async (...a: any[]) => { calls.notifyFailed.push(a); },
    },
    publications: { insert: async () => {} },
    crossPost:    { afterPublish: async () => {} },
    ...over,
  };
  return { d, calls };
}

function runner(d: any, t: PostingThrottleService) {
  return new ContentStrategyRunner(
    d.reviewer, d.dedup, d.images, d.telegram, d.notifier, t, d.publications, d.crossPost,
  );
}

const FETCHED = { sourceUrl: 'https://src/1', title: 'T', contentType: 'news', data: {} };
const POST    = { text: 'x'.repeat(60), sourceUrl: 'https://src/1', title: 'T', contentType: 'news' };

function strategy(over: Partial<Record<string, any>> = {}): any {
  return {
    type: 'space-news',
    getSkills: () => [],
    fetch: async () => FETCHED,
    generate: async () => POST,
    ...over,
  };
}

test('generic path: a throw in fetch does not leave the channel locked', async () => {
  const t = throttle();
  const { d } = deps();
  const r = runner(d, t);
  await assert.rejects(
    () => r.run(strategy({ fetch: async () => { throw new Error('rss down'); } }), '@c', {}, 's1'),
    /rss down/,
  );
  assert.equal(t.canPublish('@c'), true, 'lock released after fetch threw');
});

test('generic path: a throw in dedup / generate / review releases the lock', async () => {
  for (const over of [
    { dedup: { filterUnposted: async () => { throw new Error('db'); } } },
    { reviewer: { review: async () => { throw new Error('review'); } } },
  ]) {
    const t = throttle();
    const { d } = deps(over);
    await assert.rejects(() => runner(d, t).run(strategy(), '@c', {}, 's1'));
    assert.equal(t.canPublish('@c'), true);
  }
  const t = throttle();
  const { d } = deps();
  await assert.rejects(() => runner(d, t).run(
    strategy({ generate: async () => { throw new Error('gen'); } }), '@c', {}, 's1',
  ));
  assert.equal(t.canPublish('@c'), true);
});

test('generic path: a successful publish keeps the cooldown (lock not re-opened)', async () => {
  const t = throttle();
  const { d } = deps({
    telegram: { publish: async () => { t.recordPublish('@c'); return '42'; }, publishPrompt: async () => '42' },
  });
  await runner(d, t).run(strategy(), '@c', {}, 's1');
  assert.equal(t.canPublish('@c'), false, 'cooldown active after publish');
  assert.ok(t.remainingMs('@c') > 0);
});

test('generic path: a failed publish is notified, then rethrown so the run is recorded as error', async () => {
  const t = throttle();
  const { d, calls } = deps({
    telegram: { publish: async () => { throw new Error('Bad Request: chat not found'); }, publishPrompt: async () => '1' },
  });
  await assert.rejects(() => runner(d, t).run(strategy(), '@c', {}, 's1'), /chat not found/);
  assert.equal(calls.notifyFailed.length, 1);
  assert.equal(t.canPublish('@c'), true);
});

test('generic path: a permanent rejection from generate() marks the source errored (no publish, no markPosted)', async () => {
  const t = throttle();
  let published = false;
  const { d, calls } = deps({
    telegram: { publish: async () => { published = true; return '1'; }, publishPrompt: async () => '1' },
  });
  await runner(d, t).run(strategy({ generate: async () => ({ rejected: 'refusal: unable' }) }), '@c', {}, 's1');
  assert.equal(published, false);
  assert.deepEqual(calls.markPosted, []);
  assert.deepEqual(calls.markError, [['https://src/1', 'T', '@c', 'refusal: unable']]);
  assert.equal(t.canPublish('@c'), true);
});

test('generic path: a transient generate() failure (null) marks nothing — retried next tick', async () => {
  const t = throttle();
  const { d, calls } = deps();
  await runner(d, t).run(strategy({ generate: async () => null }), '@c', {}, 's1');
  assert.deepEqual(calls.markError, []);
  assert.deepEqual(calls.markPosted, []);
});

test('generic path: a permanent Telegram rejection marks the source errored before rethrowing', async () => {
  const t = throttle();
  const { d, calls } = deps({
    telegram: {
      publish: async () => {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: { data: { description: "Bad Request: can't parse entities" } },
        });
      },
      publishPrompt: async () => '1',
    },
  });
  await assert.rejects(() => runner(d, t).run(strategy(), '@c', {}, 's1'));
  assert.equal(calls.markError.length, 1);
  assert.equal(calls.markError[0][0], 'https://src/1');
  assert.match(calls.markError[0][3], /can't parse entities/);
});

test('generic path: a paused channel rethrows ChannelPausedError without a failure notification', async () => {
  const t = throttle();
  const { d, calls } = deps({
    telegram: { publish: async () => { throw new ChannelPausedError('@c'); }, publishPrompt: async () => '1' },
  });
  await assert.rejects(() => runner(d, t).run(strategy(), '@c', {}, 's1'), (e: unknown) => isChannelPausedError(e));
  assert.equal(calls.notifyFailed.length, 0);
});
