import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopicDigestStrategy, parseRewrite } from './topic-digest.strategy';
import type { DigestPostRow } from '../network-digest/network-digest.repository';

function make(rows: DigestPostRow[], claude: { available: boolean; reply?: string | null }, paid: any = null) {
  const sponsorMarks: any[] = [];
  const published: any[] = [];
  const chats: any[] = [];
  const s = new TopicDigestStrategy(
    { register() {} } as any,
    { postsInWindow: async () => rows } as any,
    { filterUnposted: async (i: any[]) => i, markPosted: async () => {} } as any,
    { publish: async (p: any) => { published.push(p); return '1'; } } as any,
    { notifyPublished: async () => {}, notifyFailed: async () => {} } as any,
    { insert: async () => {} } as any,
    {
      get available() { return claude.available; },
      chat: async (...args: any[]) => { chats.push(args); return claude.reply ?? null; },
    } as any,
    { findForDay: async () => paid, markPublished: async (...a: any[]) => { sponsorMarks.push(a); } } as any,
  );
  return { s, published, chats, sponsorMarks };
}

const row = (i: number, title = `Заголовок ${i}`): DigestPostRow => ({
  channelKey: '@ua_news_local', username: null, messageId: i, title,
  views: null, postedAt: new Date(Date.now() - i * 3_600_000),
});

test('parseRewrite: valid JSON with full coverage → map; partial/garbage → null', () => {
  const ok = parseRewrite('[{"i":0,"line":"A"},{"i":1,"line":"B"}]', 2);
  assert.ok(ok);
  assert.equal(ok!.get(1), 'B');
  assert.equal(parseRewrite('[{"i":0,"line":"A"}]', 2), null, 'partial coverage rejected');
  assert.equal(parseRewrite('not json', 2), null);
  assert.equal(parseRewrite(null, 2), null);
});

test('AI rewrites are used when the JSON contract holds', async () => {
  const reply = JSON.stringify([
    { i: 0, line: 'Стисло перше' }, { i: 1, line: 'Стисло друге' }, { i: 2, line: 'Стисло третє' },
  ]);
  const { s, published } = make([row(3), row(2), row(1)], { available: true, reply });
  await s.execute('@topic_hub', {});
  assert.equal(published.length, 1);
  assert.match(published[0].text, /Стисло перше/);
  assert.doesNotMatch(published[0].text, /Заголовок 3</);
});

test('garbage AI reply falls back to original titles — digest still ships', async () => {
  const { s, published } = make([row(3), row(2), row(1)], { available: true, reply: 'ой, не JSON' });
  await s.execute('@topic_hub', {});
  assert.equal(published.length, 1);
  assert.match(published[0].text, /Заголовок 3/);
});

test('AI unavailable → no chat call, original titles used', async () => {
  const { s, published, chats } = make([row(3), row(2), row(1)], { available: false });
  await s.execute('@topic_hub', {});
  assert.equal(chats.length, 0);
  assert.equal(published.length, 1);
  assert.match(published[0].text, /Заголовок 1/);
});

test('skips under minItems; dedup sentinel is topic-scoped and date-keyed', async () => {
  const { s, published } = make([row(1)], { available: false });
  await s.execute('@topic_hub', {});
  assert.equal(published.length, 0);

  const { s: s2, published: p2 } = make([row(3), row(2), row(1)], { available: false });
  await s2.execute('@topic_hub', {});
  assert.match(p2[0].source, /^digest:\/\/topic\/@topic_hub\/\d{4}-\d{2}-\d{2}$/);
});

test('paid digest_sponsor order renders as a UTM link and is marked published with the digest message', async () => {
  const paid = { orderId: 'abcdef12-0000-0000-0000-000000000000', text: 'Партнер', url: 'https://p.ua/x' };
  const { s, published, sponsorMarks } = make([row(3), row(2), row(1)], { available: false }, paid);
  await s.execute('@topic_hub', {});
  assert.match(published[0].text, /<a href="https:\/\/p\.ua\/x\?utm_source=ai0&amp;utm_medium=telegram&amp;utm_campaign=abcdef12">Партнер<\/a>/);
  assert.match(published[0].text, /#реклама/);
  assert.deepEqual(sponsorMarks, [[paid.orderId, '@topic_hub', '1']]);
});
