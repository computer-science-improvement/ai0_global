import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApiTools } from './api-tools';
import { redactSecrets, withQuery } from './api-adapters';
import type { ToolContext } from '../harness/tool';

const NOW = new Date('2026-10-01T09:00:00Z');
const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

type Route = (url: URL) => { status?: number; body: unknown } | undefined;

/** Fake HTTP: records every URL and answers from the first matching route. */
function fakeHttp(route: Route, env: Record<string, string> = {}) {
  const urls: URL[] = [];
  const get = async (u: string) => {
    const url = new URL(u);
    urls.push(url);
    const r = route(url) ?? { status: 404, body: { error: 'nope' } };
    return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, data: JSON.stringify(r.body) };
  };
  const [tool] = buildApiTools({ env: (k) => env[k], now: () => NOW, lookup, get });
  const call = (source: string, params: Record<string, unknown> = {}) => tool.execute({ source, params } as any, ctx) as Promise<any>;
  return { call, urls, tool };
}

test('fetch_api is a read tool for every role, with all sources in its description', () => {
  const { tool } = fakeHttp(() => undefined);
  assert.equal(tool.kind, 'read');
  assert.deepEqual(tool.roles, ['planner', 'executor', 'reviewer']);
  for (const s of ['nasa_apod', 'spaceflight_news', 'tmdb_trending', 'epic_free_games', 'steam_deals', 'gamerpower_giveaways', 'on_this_day']) {
    assert.match(tool.description, new RegExp(s));
  }
});

test('nasa_apod: DEMO_KEY fallback, page url, hd image; key never leaks into output', async () => {
  const { call, urls } = fakeHttp((u) => (u.hostname === 'api.nasa.gov'
    ? { body: { media_type: 'image', title: 'Ring Nebula', explanation: 'A ring.', url: 'https://apod.nasa.gov/i.jpg', hdurl: 'https://apod.nasa.gov/hd.jpg', date: '2026-10-01', copyright: 'Jane' } }
    : undefined));
  const r = await call('nasa_apod', { date: '2026-10-01' });
  assert.equal(urls[0].searchParams.get('api_key'), 'DEMO_KEY');
  assert.equal(urls[0].searchParams.get('date'), '2026-10-01');
  assert.deepEqual(r.items[0], {
    title: 'Ring Nebula', summary: 'A ring.', url: 'https://apod.nasa.gov/apod/ap261001.html', image: 'https://apod.nasa.gov/i.jpg',
    date: '2026-10-01', extra: { hd_image: 'https://apod.nasa.gov/hd.jpg', copyright: 'Jane' },
  });
});

test('nasa_apod: a video day is returned without image and with a note', async () => {
  const { call } = fakeHttp(() => ({ body: { media_type: 'video', title: 'Launch', explanation: 'x', url: 'https://youtube.com/embed/1', date: '2026-10-01' } }));
  const r = await call('nasa_apod', {}, );
  assert.equal(r.items[0].image, null);
  assert.equal(r.items[0].extra.media_url, 'https://youtube.com/embed/1');
  assert.match(r.note, /video/);
});

test('spaceflight_news: limit/search query, normalized items', async () => {
  const { call, urls } = fakeHttp(() => ({ body: { results: [{ id: 1, title: 'Starship flies', url: 'https://spacenews.com/a', image_url: 'https://img/a.jpg', summary: 'It flew.', published_at: '2026-10-01T08:00:00Z', news_site: 'SpaceNews' }] } }));
  const r = await call('spaceflight_news', { limit: 3, search: 'starship' });
  assert.equal(urls[0].hostname, 'api.spaceflightnewsapi.net');
  assert.equal(urls[0].searchParams.get('limit'), '3');
  assert.equal(urls[0].searchParams.get('search'), 'starship');
  assert.deepEqual(r.items[0], { title: 'Starship flies', summary: 'It flew.', url: 'https://spacenews.com/a', image: 'https://img/a.jpg', date: '2026-10-01T08:00:00Z', extra: { news_site: 'SpaceNews' } });
});

test('tmdb_trending: needs TMDB_API_KEY; maps tv/movie; vote filter', async () => {
  const none = fakeHttp(() => undefined);
  assert.equal((await none.call('tmdb_trending')).error, 'missing_api_key');
  assert.equal(none.urls.length, 0);

  const { call, urls } = fakeHttp(() => ({ body: { results: [
    { id: 7, name: 'Show', original_name: 'Show', first_air_date: '2026-09-01', overview: 'Plot', vote_average: 8.1, vote_count: 900, genre_ids: [18], poster_path: '/p.jpg' },
    { id: 8, name: 'Obscure', overview: 'x', vote_count: 2 },
  ] } }), { TMDB_API_KEY: 'secret-tmdb' });
  const r = await call('tmdb_trending', { media: 'tv', window: 'day', limit: 5 });
  assert.equal(urls[0].pathname, '/3/trending/tv/day');
  assert.equal(urls[0].searchParams.get('api_key'), 'secret-tmdb');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].url, 'https://www.themoviedb.org/tv/7');
  assert.deepEqual(r.items[0].extra.genres, ['Drama']);
  assert.ok(!JSON.stringify(r).includes('secret-tmdb'));
});

test('epic_free_games: only currently-free offers, end date in extra', async () => {
  const { call } = fakeHttp(() => ({ body: { data: { Catalog: { searchStore: { elements: [
    { title: 'Free Game', description: 'Fun', productSlug: 'free-game', keyImages: [{ type: 'OfferImageWide', url: 'https://cdn/wide.jpg' }],
      promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: '2026-09-25T15:00:00Z', endDate: '2026-10-02T15:00:00Z', discountSetting: { discountPercentage: 0 } }] }] } },
    { title: 'Coming', promotions: { promotionalOffers: [] } },
  ] } } } } }));
  const r = await call('epic_free_games');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].url, 'https://store.epicgames.com/en-US/p/free-game');
  assert.equal(r.items[0].extra.ends_at, '2026-10-02T15:00:00Z');
});

test('steam_deals: discount filter, limit, best-effort enrichment', async () => {
  const { call, urls } = fakeHttp((u) => {
    if (u.pathname === '/api/featuredcategories/') {
      return { body: { specials: { items: [
        { id: 1, name: 'Big Sale', discount_percent: 80, final_price: 199, original_price: 999, currency: 'USD', header_image: 'https://h/1.jpg' },
        { id: 2, name: 'Small Sale', discount_percent: 10 },
      ] } } };
    }
    if (u.pathname === '/api/appdetails') return { body: { 1: { success: true, data: { short_description: 'Roguelike', genres: [{ description: 'Indie' }] } } } };
    if (u.pathname === '/appreviews/1') return { status: 500, body: {} }; // enrichment failure is tolerated
    return undefined;
  });
  const r = await call('steam_deals', { min_discount: 50 });
  assert.equal(r.items.length, 1);
  assert.deepEqual([r.items[0].title, r.items[0].summary, r.items[0].extra.sale_price, r.items[0].extra.review_score], ['Big Sale', 'Roguelike', '1.99 USD', null]);
  assert.deepEqual(r.items[0].extra.genres, ['Indie']);
  assert.equal(urls.length, 3);

  const bare = fakeHttp((u) => (u.pathname === '/api/featuredcategories/' ? { body: { specials: { items: [{ id: 1, name: 'X', discount_percent: 90 }] } } } : undefined));
  await bare.call('steam_deals', { enrich: false });
  assert.equal(bare.urls.length, 1);
});

test('gamerpower_giveaways: platform/type filters are passed, inactive dropped', async () => {
  const { call, urls } = fakeHttp(() => ({ body: [
    { id: 1, title: 'Loot', description: 'Free loot', instructions: 'Claim', type: 'Loot', platforms: 'PC, Steam', end_date: 'N/A', gamerpower_url: 'https://gamerpower.com/1', image: 'https://g/1.jpg', published_date: '2026-09-30', status: 'Active' },
    { id: 2, title: 'Old', status: 'Expired', end_date: 'N/A' },
  ] }));
  const r = await call('gamerpower_giveaways', { platform: 'steam', type: 'loot' });
  assert.equal(urls[0].searchParams.get('platform'), 'steam');
  assert.equal(urls[0].searchParams.get('type'), 'loot');
  assert.deepEqual(r.items.map((i: any) => i.title), ['Loot']);
});

test('on_this_day: defaults to the Kyiv date, keeps wikipedia links', async () => {
  const { call, urls } = fakeHttp(() => ({ body: { births: [{ year: '1900', description: 'Someone born', wikipedia: [{ title: 'Someone', wikipedia: 'https://en.wikipedia.org/wiki/Someone' }] }] } }));
  const r = await call('on_this_day', { kind: 'births' });
  assert.equal(urls[0].pathname, '/on-this-day/10/1/births.json');
  assert.deepEqual(r.items[0], {
    title: '1900: Someone born', summary: 'Someone born', url: 'https://en.wikipedia.org/wiki/Someone', image: null, date: '1900',
    extra: { kind: 'births', month: 10, day: 1 },
  });
});

test('invalid params, upstream HTTP errors and SSRF are returned as tool errors', async () => {
  const { call } = fakeHttp(() => ({ status: 503, body: {} }));
  assert.equal((await call('spaceflight_news', { limit: 99 })).error, 'invalid_params');
  assert.equal((await call('epic_free_games', { unknown: 1 })).error, 'invalid_params');
  const http = await call('spaceflight_news');
  assert.equal(http.error, 'http_error');
  assert.match(http.details, /503/);

  const [tool] = buildApiTools({ env: () => undefined, lookup: async () => [{ address: '10.0.0.5', family: 4 }], get: async () => { throw new Error('must not be called'); } });
  const r: any = await tool.execute({ source: 'epic_free_games', params: {} } as any, ctx);
  assert.equal(r.error, 'fetch_failed');
});

test('redactSecrets / withQuery', () => {
  assert.equal(redactSecrets('GET https://api.nasa.gov/x?api_key=abc123&date=1 failed'), 'GET https://api.nasa.gov/x?api_key=***&date=1 failed');
  assert.equal(withQuery('https://a.b/c?x=1', { y: 2, z: undefined }), 'https://a.b/c?x=1&y=2');
});
