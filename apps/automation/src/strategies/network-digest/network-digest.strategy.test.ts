import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkDigestStrategy } from './network-digest.strategy';
import type { DigestPostRow } from './network-digest.repository';

function make(rows: DigestPostRow[], opts: { alreadyPosted?: boolean; subsDelta?: number; paid?: any; publishFails?: boolean } = {}) {
  const published: any[] = [];
  const marked: any[] = [];
  const registry = { register() {} };
  const repo = {
    postsInWindow: async () => rows,
    subsDelta: async () => opts.subsDelta ?? 0,
  };
  const dedup = {
    filterUnposted: async (items: any[]) => (opts.alreadyPosted ? [] : items),
    markPosted: async (...args: any[]) => { marked.push(args); },
  };
  const telegram = { publish: async (payload: any) => {
    if (opts.publishFails) throw new Error('boom');
    published.push(payload); return '777';
  } };
  const sponsorMarks: any[] = [];
  const sponsorLookups: any[] = [];
  const sponsors = {
    findForDay: async (...a: any[]) => { sponsorLookups.push(a); return opts.paid ?? null; },
    markPublished: async (...a: any[]) => { sponsorMarks.push(a); },
  };
  const notifier = { notifyPublished: async () => {}, notifyFailed: async () => {} };
  const publications = { insert: async () => {} };
  const s = new NetworkDigestStrategy(
    registry as any, repo as any, dedup as any, telegram as any,
    notifier as any, publications as any, sponsors as any,
  );
  return { s, published, marked, sponsorMarks, sponsorLookups };
}

const row = (over: Partial<DigestPostRow> = {}): DigestPostRow => ({
  channelKey: '@ai_news_local', username: null, messageId: 10,
  title: 'Новина дня', views: 500,
  postedAt: new Date(Date.now() - 6 * 3_600_000),
  ...over,
});

test('publishes a digest with t.me links and date-keyed dedup sentinel', async () => {
  const rows = [row({ messageId: 1 }), row({ messageId: 2 }), row({ messageId: 3 })];
  const { s, published, marked } = make(rows);
  await s.execute('@digest_hub', {});
  assert.equal(published.length, 1);
  assert.match(published[0].text, /t\.me\/ai_news_local\/1/);
  assert.match(published[0].source, /^digest:\/\/network\/@digest_hub\/\d{4}-\d{2}-\d{2}$/);
  assert.equal(marked.length, 1);
  assert.equal(marked[0][0], published[0].source);
});

test('skips when already posted today (dedup hit) — no publish', async () => {
  const { s, published } = make([row(), row(), row()], { alreadyPosted: true });
  await s.execute('@digest_hub', {});
  assert.equal(published.length, 0);
});

test('skips when fewer than minItems posts in window', async () => {
  const { s, published } = make([row(), row()]);
  await s.execute('@digest_hub', { minItems: 3 });
  assert.equal(published.length, 0);
});

test('ranks by views/hour, not raw views (old high-view post loses to fresh riser)', async () => {
  const now = Date.now();
  const rows = [
    row({ messageId: 1, title: 'OLD', views: 1000, postedAt: new Date(now - 20 * 3_600_000) }), // 50/h
    row({ messageId: 2, title: 'FRESH', views: 600, postedAt: new Date(now - 4 * 3_600_000) }), // 150/h
    row({ messageId: 3, title: 'MID', views: 300, postedAt: new Date(now - 10 * 3_600_000) }),  // 30/h
  ];
  const { s, published } = make(rows);
  await s.execute('@digest_hub', {});
  const text = published[0].text as string;
  assert.ok(text.indexOf('FRESH') < text.indexOf('OLD'), 'fresh riser must rank above old accumulator');
});

test('sponsor param renders the partner slot as a UTM link with #реклама', async () => {
  const { s, published } = make([row({ messageId: 1 }), row({ messageId: 2 }), row({ messageId: 3 })]);
  await s.execute('@digest_hub', { sponsor: { text: 'Курс', url: 'https://x.ua' } });
  assert.match(published[0].text, /Партнер дайджесту/);
  assert.match(published[0].text, /<a href="https:\/\/x\.ua\/\?utm_source=ai0&amp;utm_medium=telegram&amp;utm_campaign=digest">Курс<\/a>/);
  assert.match(published[0].text, /#реклама/);
});

test('a paid digest_sponsor order for today wins over the static param and is marked published', async () => {
  const paid = { orderId: '0f3a9c12-aaaa-bbbb-cccc-000000000000', text: 'Школа англійської', url: 'https://school.ua' };
  const { s, published, sponsorMarks, sponsorLookups } = make([row({ messageId: 1 }), row({ messageId: 2 }), row({ messageId: 3 })], { paid });
  await s.execute('@digest_hub', { sponsor: { text: 'Статичний', url: 'https://x.ua' } });
  assert.equal(sponsorLookups[0][0], '@digest_hub');
  assert.match(sponsorLookups[0][1], /^\d{4}-\d{2}-\d{2}$/);
  assert.match(published[0].text, /utm_campaign=0f3a9c12">Школа англійської<\/a>/);
  assert.doesNotMatch(published[0].text, /Статичний/);
  assert.deepEqual(sponsorMarks, [[paid.orderId, '@digest_hub', '777']]);
});

test('paid sponsor is not marked published when the digest publish fails', async () => {
  const paid = { orderId: 'o1', text: 'S', url: 'https://s.ua' };
  const { s, sponsorMarks } = make([row({ messageId: 1 }), row({ messageId: 2 }), row({ messageId: 3 })], { paid, publishFails: true });
  await s.execute('@digest_hub', {});
  assert.equal(sponsorMarks.length, 0);
});

test('subs delta appears in the stats line when positive', async () => {
  const { s, published } = make([row({ messageId: 1 }), row({ messageId: 2 }), row({ messageId: 3 })], { subsDelta: 42 });
  await s.execute('@digest_hub', {});
  assert.match(published[0].text, /\+42/);
});

test('unlinkable-only window (private channels) skips instead of publishing empty list', async () => {
  const rows = [row({ channelKey: 'invite:a' }), row({ channelKey: '-100123' }), row({ channelKey: 'invite:b' })];
  const { s, published } = make(rows);
  await s.execute('@digest_hub', {});
  assert.equal(published.length, 0);
});
