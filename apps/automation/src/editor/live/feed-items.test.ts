import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageHours, closestRecent, filterFresh, LIVE_SIMILAR, liveFeeds, readFeed } from './feed-items';
import { itemScore, keywordHits, newsWatchConfig, NewsWatchSchema, topicKeywords } from './news-watch-config';
import { buildReadTools } from '../tools/read-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';

const NOW = new Date('2030-05-06T12:00:00Z');
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const rss = (items: Array<{ title: string; link: string; date?: string }>) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.date ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : ''}<description>d</description></item>`).join('')
}</channel></rss>`;
const ITEMS = [
  { title: 'Уряд ухвалив закон про енергоринок', link: 'https://e.example/new', date: '2030-05-06T11:30:00Z' },
  { title: 'Старе про тарифи', link: 'https://e.example/old', date: '2030-05-05T08:00:00Z' },
  { title: 'Без дати', link: 'https://e.example/nodate' },
];
const get = async () => ({ status: 200, headers: { 'content-type': 'application/rss+xml' }, data: rss(ITEMS) });

test('readFeed gives every item its age in hours (null without a date, 0 for the future)', async () => {
  const f = await readFeed('https://e.example/rss', NOW, { lookup, get });
  assert.deepEqual(f.items.map((i) => i.age_hours), [0.5, 28, null]);
  assert.equal(ageHours('2030-05-06T13:00:00Z', NOW), 0);
  assert.equal(ageHours('not a date', NOW), null);
});

test('filterFresh: since_hours drops old and undated items; the ledger and the 7-day repeat check drop used ones', async () => {
  const f = await readFeed('https://e.example/rss', NOW, { lookup, get });
  const onlyAge = await filterFresh(f.items, { sinceHours: 6, now: NOW });
  assert.deepEqual(onlyAge.kept.map((x) => x.link), ['https://e.example/new']);
  assert.deepEqual(onlyAge.dropped, { old: 1, undated: 1, posted: 0, similar: 0 });

  const pool = { query: async (sql: string) => {
    if (/content_ledger_blocking/.test(sql)) return { rows: [{ u: 'https://e.example/b' }] };
    return { rows: [{ text: 'Сьогодні уряд ухвалив закон про енергоринок: що зміниться для споживачів.' }] };
  } } as any;
  const items = [
    { title: 'Уряд ухвалив закон про енергоринок', link: 'https://e.example/a', age_hours: 1 },
    { title: 'Хтось опублікований раніше', link: 'https://e.example/b', age_hours: 1 },
    { title: 'НЕК запустила новий аукціон потужностей', link: 'https://e.example/c', age_hours: 2 },
    { title: 'НЕК запустила новий аукціон потужностей', link: 'https://other.example/c', age_hours: 2 },
  ];
  const r = await filterFresh(items, { sinceHours: 6, pool, resourceRef: 'telegram:@x', now: NOW });
  assert.deepEqual(r.kept.map((x) => x.link), ['https://e.example/c'], 'posted, similar to a recent post and the same story from a second feed are dropped');
  assert.deepEqual(r.dropped, { old: 0, undated: 0, posted: 1, similar: 2 });
  assert.ok(closestRecent('Уряд ухвалив закон про енергоринок', ['Сьогодні уряд ухвалив закон про енергоринок.']) >= LIVE_SIMILAR);
  assert.ok(closestRecent('Google випустила Android 16', ['Сьогодні уряд ухвалив закон про енергоринок.']) < LIVE_SIMILAR);
});

test('liveFeeds resolves card ids, feed:<id> and URLs; api sources are left to the agent', () => {
  const card = [{ id: 'f1', kind: 'rss' as const, ref: 'https://e.example/rss' }, { id: 'lib', kind: 'library' as const, ref: 'recipes' }];
  assert.deepEqual(liveFeeds(['f1', 'feed:f1', 'https://x.example/rss', 'api:nasa_apod', 'lib'], card), {
    feeds: [{ url: 'https://e.example/rss', id: 'f1' }, { url: 'https://x.example/rss', id: 'https://x.example/rss' }],
    other: ['api:nasa_apod', 'lib'],
  });
});

test('fetch_feed: since_hours and age_hours; exclude_posted needs a resource and filters through the ledger', async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; } } as any;
  const tools = Object.fromEntries(buildReadTools({ pool, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: { lookup, get }, now: () => NOW }).map((t) => [t.name, t]));
  const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan', slotId: '11111111-1111-4111-8111-111111111111' };
  const all: any = await tools.fetch_feed.execute({ url: 'https://e.example/rss', limit: 10, exclude_posted: false }, ctx);
  assert.deepEqual(all.items.map((i: any) => i.age_hours), [0.5, 28, null]);
  assert.equal(all.dropped, undefined);
  const fresh: any = await tools.fetch_feed.execute({ url: 'https://e.example/rss', limit: 10, since_hours: 6, exclude_posted: true }, ctx);
  assert.deepEqual(fresh.items.map((i: any) => i.link), ['https://e.example/new']);
  assert.deepEqual(fresh.dropped, { old: 1, undated: 1, posted: 0, similar: 0 });
  assert.ok(calls.some((s) => /content_ledger_blocking/.test(s)), 'the ledger was asked');
  const none: any = await tools.fetch_feed.execute({ url: 'https://e.example/rss', limit: 10, exclude_posted: true }, { ...ctx, channelKey: null });
  assert.equal(none.error, 'no_resource');
});

test('news watch config: on by default for a news card with feeds, off when disabled or not news; owner settings override', () => {
  const card = { brief: 'Новини енергетики України', title: 'Енергія', formats: { text: 1 }, sources: [{ id: 'f1', kind: 'rss' as const, ref: 'https://e.example/rss' }] };
  const cfg = newsWatchConfig(card, null)!;
  assert.deepEqual({ ...cfg, keywords: undefined }, {
    everyHours: 2, fromHour: 8, toHour: 22, maxPerDay: 3, maxAgeHours: 3, feeds: [{ id: 'f1', url: 'https://e.example/rss' }], keywords: undefined,
  });
  assert.ok(cfg.keywords.includes('енерг'));
  assert.ok(!cfg.keywords.includes('новин'), 'generic words are not topic keywords');
  assert.equal(newsWatchConfig(card, { news_watch: { enabled: false } }), null);
  assert.equal(newsWatchConfig({ ...card, brief: 'Рецепти', title: 'Кухня' }, null), null, 'not a news resource');
  assert.ok(newsWatchConfig({ ...card, brief: 'Рецепти', title: 'Кухня' }, { news_watch: { enabled: true } }), 'the owner can turn it on anywhere');
  assert.equal(newsWatchConfig({ ...card, sources: [] }, { news_watch: { enabled: true } }), null, 'no feeds, nothing to watch');
  assert.equal(newsWatchConfig(card, { news_watch: { every_hours: 1, max_per_day: 5 } })!.everyHours, 1);
  assert.equal(NewsWatchSchema.safeParse({ from_hour: 22, to_hour: 8 }).success, false);
  assert.equal(NewsWatchSchema.safeParse({ every: 2 }).success, false, 'strict');
});

test('keywords and the item score', () => {
  const kw = topicKeywords(['Енергетика і енергоринок України', 'Короткі новини']);
  assert.deepEqual(kw, ['енерг']);
  assert.equal(keywordHits('Енергетики обговорили ринок', kw), 1);
  assert.equal(keywordHits('Футбол', kw), 0);
  assert.equal(itemScore(0, 3, 1, 1), 0.667);
  assert.equal(itemScore(3, 3, 0, 0), 0.25);
});
