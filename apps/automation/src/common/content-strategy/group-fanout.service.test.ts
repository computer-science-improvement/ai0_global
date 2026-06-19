import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroupFanOutService, GroupContent } from './group-fanout.service';

const META_TARGET = (platform: string, id: string) => ({
  platform, targetId: `tgt-${id}`, token: `tok-${id}`,
  metaAccountId: id, postedKey: `X:${id}`, throttleKey: `meta:${id}`,
});
const TG_TARGET = { platform: 'telegram', targetId: 'recipes', metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: 'recipes' };

function make(overrides: any = {}) {
  const calls: any = { carousel: [], single: [], telegram: [], posted: [] };
  const resolver = {
    resolveGroupForDest: async (_d: any) => 'groupForDest' in overrides ? overrides.groupForDest : { groupId: 'g1', sourcePlatform: 'facebook', isSource: true },
    resolveGroupTargets: async (_g: string, _ex: string) => overrides.targets ?? [META_TARGET('instagram', 'ig'), META_TARGET('threads', 'th'), TG_TARGET],
  };
  const dispatcher = {
    publishCarousel: async (p: string, _pay: any, _urls: string[], _t: any) => { calls.carousel.push(p); return `c-${p}`; },
    publish:         async (p: string, _pay: any, _t: any) => { calls.single.push(p); return `s-${p}`; },
  };
  const telegram = {
    publish: async (_pay: any, t: any) => { calls.telegram.push(t.id); return 'tg-1'; },
  };
  const tracer = { span: (_s: any, _a: any, f: any) => f(), event() {}, steps: () => [], describeError: (e: any) => String(e?.message ?? e) };
  const svc = new GroupFanOutService(resolver as any, dispatcher as any, telegram as any, tracer as any);
  const markPosted = async (key: string) => { calls.posted.push(key); };
  return { svc, calls, markPosted };
}

const SOURCE_FB = { platform: 'facebook', targetId: 'fb', token: 't', metaAccountId: 'fb', postedKey: 'FB:fb', throttleKey: 'meta:fb' } as any;
const CONTENT: GroupContent = { caption: 'A tasty caption that is long enough.', tags: ['food'], imageUrls: ['u1', 'u2', 'u3'], carousel: true };

test('fans a carousel out to Meta siblings + Telegram cover when dest is the source', async () => {
  const { svc, calls } = make();
  await svc.fanOut(SOURCE_FB, CONTENT, async () => {});
  assert.deepEqual(calls.carousel.sort(), ['instagram', 'threads']);
  assert.deepEqual(calls.telegram, ['recipes']);
});

test('marks each target posted with its own dedup key', async () => {
  const { svc, calls, markPosted } = make();
  await svc.fanOut(SOURCE_FB, CONTENT, markPosted);
  assert.deepEqual(calls.posted.sort(), ['TELEGRAM', 'X:ig', 'X:th']);
});

test('no-op when dest is NOT the group source', async () => {
  const { svc, calls } = make({ groupForDest: { groupId: 'g1', sourcePlatform: 'telegram', isSource: false } });
  await svc.fanOut(SOURCE_FB, CONTENT, async () => {});
  assert.deepEqual(calls.carousel, []);
  assert.deepEqual(calls.telegram, []);
});

test('no-op when dest is in no group', async () => {
  const { svc, calls } = make({ groupForDest: null });
  await svc.fanOut(SOURCE_FB, CONTENT, async () => {});
  assert.deepEqual(calls.carousel, []);
});

test('non-carousel content uses single publish for Meta', async () => {
  const { svc, calls } = make({ targets: [META_TARGET('instagram', 'ig')] });
  await svc.fanOut(SOURCE_FB, { ...CONTENT, carousel: false, imageUrls: ['only'] }, async () => {});
  assert.deepEqual(calls.single, ['instagram']);
  assert.deepEqual(calls.carousel, []);
});

test('a failing target never blocks the others and is not marked posted', async () => {
  const { svc, calls, markPosted } = make({ targets: [META_TARGET('instagram', 'ig'), TG_TARGET] });
  const telegram = { publish: async () => { throw new Error('no bot bound'); } };
  (svc as any).telegram = telegram;
  await svc.fanOut(SOURCE_FB, CONTENT, markPosted);
  assert.deepEqual(calls.carousel, ['instagram']);
  assert.deepEqual(calls.posted, ['X:ig']);
});
