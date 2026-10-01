// 002 T007 — digest correctness: clamped params, unlinkable channels dropped
// before the top-N slice, strategy-aware titles, Kyiv-time cron, retry window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NetworkDigestStrategy, normalizeParams as normalizeNetwork,
} from './network-digest.strategy';
import {
  TopicDigestStrategy, normalizeParams as normalizeTopic,
} from '../topic-digest/topic-digest.strategy';
import { DIGEST_RETRY_SCHEDULE, digestTitle } from './digest-format.util';
import { SCHEDULE_TIME_ZONE, makeCronJob } from '../../scheduler/schedule-time-zone';
import type { DigestPostRow } from './network-digest.repository';

const row = (over: Partial<DigestPostRow> = {}): DigestPostRow => ({
  channelKey: '@pub', username: null, messageId: 1, title: 'Новина', views: 100,
  postedAt: new Date(Date.now() - 6 * 3_600_000), strategyType: 'ai0-news',
  ...over,
});

test('normalizeParams clamps minItems to maxItems (no digest that can never publish)', () => {
  assert.equal(normalizeNetwork({ maxItems: 5, minItems: 9 }).minItems, 5);
  assert.equal(normalizeTopic({ maxItems: 4, minItems: 7 }).minItems, 4);
  assert.equal(normalizeNetwork({ maxItems: 8, minItems: 3 }).minItems, 3);
});

test('network-digest: unlinkable channels are dropped BEFORE the top-N slice', async () => {
  // The three best-ranked posts are on private channels; three linkable ones
  // rank lower. Old behaviour: slice(0, 3) took only unlinkable rows → skip.
  const rows = [
    row({ channelKey: '-1001', messageId: 1, views: 9000 }),
    row({ channelKey: 'invite:x', messageId: 2, views: 8000 }),
    row({ channelKey: '-1002', messageId: 3, views: 7000 }),
    row({ messageId: 4, views: 30 }),
    row({ messageId: 5, views: 20 }),
    row({ messageId: 6, views: 10 }),
  ];
  const published: any[] = [];
  const s = new NetworkDigestStrategy(
    { register() {} } as any,
    { postsInWindow: async () => rows, subsDelta: async () => 0 } as any,
    { filterUnposted: async (i: any[]) => i, markPosted: async () => {} } as any,
    { publish: async (p: any) => { published.push(p); return '1'; } } as any,
    { notifyPublished: async () => {}, notifyFailed: async () => {} } as any,
    { insert: async () => {} } as any,
  );
  await s.execute('@hub', { maxItems: 3, minItems: 3 });
  assert.equal(published.length, 1);
  for (const id of [4, 5, 6]) assert.match(published[0].text, new RegExp(`t\\.me/pub/${id}\\b`));
});

test('topic-digest: unlinkable channels are dropped BEFORE the newest-tail slice', async () => {
  const now = Date.now();
  const rows = [ // chronological (repo returns ASC)
    row({ messageId: 1, postedAt: new Date(now - 9e6) }),
    row({ messageId: 2, postedAt: new Date(now - 8e6) }),
    row({ messageId: 3, postedAt: new Date(now - 7e6) }),
    row({ channelKey: '-1009', messageId: 4, postedAt: new Date(now - 3e6) }),
    row({ channelKey: '-1009', messageId: 5, postedAt: new Date(now - 2e6) }),
    row({ channelKey: '-1009', messageId: 6, postedAt: new Date(now - 1e6) }),
  ];
  const published: any[] = [];
  const s = new TopicDigestStrategy(
    { register() {} } as any,
    { postsInWindow: async () => rows } as any,
    { filterUnposted: async (i: any[]) => i, markPosted: async () => {} } as any,
    { publish: async (p: any) => { published.push(p); return '1'; } } as any,
    { notifyPublished: async () => {}, notifyFailed: async () => {} } as any,
    { insert: async () => {} } as any,
    { available: false } as any,
  );
  await s.execute('@hub', { maxItems: 3, minItems: 3, rewriteWithAi: false });
  assert.equal(published.length, 1);
  for (const id of [1, 2, 3]) assert.match(published[0].text, new RegExp(`t\\.me/pub/${id}\\b`));
});

test('digestTitle: strategy-aware cleanup of published_posts titles', () => {
  assert.equal(digestTitle('Сенека', 'quotes'), 'Цитата: Сенека');
  assert.equal(digestTitle('quote', 'quotes'), 'Цитата дня');
  assert.equal(digestTitle('a cat astronaut, 8k, octane render', 'ai0-prompts'), 'Промпт: a cat astronaut, 8k, octane render');
  assert.equal(digestTitle('Пом Анна', 'recipes'), 'Рецепт: Пом Анна');
  assert.equal(digestTitle('Ада Лавлейс', 'birthday-strategy'), 'Біографія: Ада Лавлейс');
  // Any type: HTML tags stripped, whitespace collapsed.
  assert.equal(digestTitle('  <b>Apple</b>\n  випустила   iPhone ', 'ai0-news'), 'Apple випустила iPhone');
  assert.equal(digestTitle('Без типу', null), 'Без типу');
});

test('network-digest renders strategy-aware titles', async () => {
  const published: any[] = [];
  const rows = [
    row({ messageId: 1, title: 'Сенека', strategyType: 'quotes' }),
    row({ messageId: 2, title: 'Новина А' }),
    row({ messageId: 3, title: 'Новина Б' }),
  ];
  const s = new NetworkDigestStrategy(
    { register() {} } as any,
    { postsInWindow: async () => rows, subsDelta: async () => 0 } as any,
    { filterUnposted: async (i: any[]) => i, markPosted: async () => {} } as any,
    { publish: async (p: any) => { published.push(p); return '1'; } } as any,
    { notifyPublished: async () => {}, notifyFailed: async () => {} } as any,
    { insert: async () => {} } as any,
  );
  await s.execute('@hub', {});
  assert.match(published[0].text, /Цитата: Сенека/);
});

test('retry-window default: every 10 min during the 19:00–20:59 Kyiv window', () => {
  assert.equal(DIGEST_RETRY_SCHEDULE, '*/10 19-20 * * *');
});

test('scheduler cron zone is opt-in via SCHEDULER_TZ (unset = process TZ)', () => {
  assert.equal(SCHEDULE_TIME_ZONE, process.env.SCHEDULER_TZ || undefined);
  const job = makeCronJob('0 19 * * *', () => {});
  const next = job.nextDate();
  if (SCHEDULE_TIME_ZONE) assert.equal(next.zoneName, SCHEDULE_TIME_ZONE);
  assert.equal(next.hour, 19);
  assert.equal(next.minute, 0);
});
