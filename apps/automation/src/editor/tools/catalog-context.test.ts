// Spec 023 T2: the catalog additions — APIs without secrets, feeds, runway, the prompt summary and its cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCatalog, cardFeeds, catalogPromptSummary, PROMPT_SUMMARY_MAX, runwayDays, TtlCache } from './catalog-context';
import { API_SOURCE_NAMES } from './api-adapters/names';
import { pickNetworkHighlights, pickTopicHighlights, postLink } from '../../common/digests/digest-selection';

test('apis: every adapter, configured from the presence of its key, never the value', () => {
  const secret = 'tmdb-SECRET-123';
  const withKey = apiCatalog((k) => (k === 'TMDB_API_KEY' ? secret : undefined));
  assert.deepEqual(withKey.map((a) => a.name), [...API_SOURCE_NAMES]);
  assert.equal(withKey.find((a) => a.name === 'tmdb_trending')!.configured, true);
  assert.equal(withKey.find((a) => a.name === 'nasa_apod')!.configured, true, 'NASA falls back to DEMO_KEY');
  assert.ok(!JSON.stringify(withKey).includes(secret));
  assert.equal(apiCatalog(() => undefined).find((a) => a.name === 'tmdb_trending')!.configured, false);
  assert.ok(withKey.every((a) => a.description.length > 0 && a.description.length <= 160 && !a.description.includes('params:')));
});

test('feeds: only rss / url sources of the card', () => {
  assert.deepEqual(cardFeeds([
    { id: 'a', kind: 'rss', ref: 'https://x/rss', note: 'news' }, { id: 'b', kind: 'library', ref: 'recipes' }, { id: 'c', kind: 'url', ref: 'https://y' },
  ]), [{ id: 'a', kind: 'rss', ref: 'https://x/rss', note: 'news' }, { id: 'c', kind: 'url', ref: 'https://y' }]);
  assert.deepEqual(cardFeeds(undefined), []);
});

test('runway: unposted ÷ the larger of series per day and 28-day usage; null when nothing uses it', () => {
  assert.equal(runwayDays(30, 1, 0), 30);
  assert.equal(runwayDays(30, 1, 56), 15, '2 a day from the ledger beats 1 a day from the series');
  assert.equal(runwayDays(10, 0, 7), 40);
  assert.equal(runwayDays(10, 0, 0), null);
  assert.equal(runwayDays(undefined, 1, 0), null);
});

test('prompt summary stays within 1,500 characters and names the other sources', () => {
  const datasets = Array.from({ length: 60 }, (_, i) => ({
    dataset: `dataset_${i}`, title: `Датасет номер ${i} з довгою назвою для перевірки`, entity: 'x', description: '', suitable_for: '', language: 'uk',
    fields: [], rows: 1000 + i, unposted_here: 500 + i, unposted_network: 10, top_categories: [], runway_days: i,
  }));
  const s = catalogPromptSummary({ datasets, apis: [{ name: 'nasa_apod', description: 'x', configured: true }, { name: 'tmdb_trending', description: 'y', configured: false }], feeds: [{ id: 'f1', kind: 'rss', ref: 'https://x' }] });
  assert.ok(s.length <= PROMPT_SUMMARY_MAX, String(s.length));
  assert.ok(s.endsWith('…'));
  const small = catalogPromptSummary({ datasets: datasets.slice(0, 2), apis: [{ name: 'nasa_apod', description: 'x', configured: true }, { name: 'tmdb_trending', description: 'y', configured: false }], feeds: [{ id: 'f1', kind: 'rss', ref: 'https://x' }] });
  assert.match(small, /API \(fetch_api\): nasa_apod$/m, 'an unconfigured API is left out');
  assert.match(small, /fetch_feed\): f1/);
  assert.match(small, /get_network_highlights/);
  assert.match(small, /запас 1 дн\./);
});

test('cache: 10 minutes per key', async () => {
  let t = 0;
  let n = 0;
  const c = new TtlCache<number>(600_000, () => t);
  assert.equal(await c.get('a', async () => ++n), 1);
  t = 599_999;
  assert.equal(await c.get('a', async () => ++n), 1);
  t = 600_000;
  assert.equal(await c.get('a', async () => ++n), 2);
});

test('digest selection (moved from the strategies): network ranks by views per hour, topic keeps the newest tail', () => {
  const now = new Date('2026-10-07T18:00:00Z');
  const row = (i: number, views: number | null, hoursAgo: number, channelKey = '@pub') => ({
    channelKey, username: null, messageId: i, title: `<b>Пост ${i}</b>`, views, postedAt: new Date(now.getTime() - hoursAgo * 3600_000), strategyType: i === 1 ? 'quotes' : 'editor',
  });
  const rows = [row(1, 100, 10), row(2, 900, 3), row(3, 50, 1), row(4, 10_000, 5, '-100123')];
  const net = pickNetworkHighlights(rows, now, 2);
  assert.deepEqual(net.map((r) => r.messageId), [2, 3], 'unlinkable channels dropped before the top N');
  assert.equal(pickNetworkHighlights(rows, now, 8).find((r) => r.messageId === 1)!.title, 'Цитата: Пост 1');
  assert.deepEqual(pickTopicHighlights(rows, 2).map((r) => r.messageId), [2, 3]);
  assert.equal(postLink(rows[0]), 'https://t.me/pub/1');
  assert.equal(postLink(rows[3]), null);
});
