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
  assert.deepEqual(tool.roles, ['planner', 'executor', 'reviewer', 'composer']);
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
  assert.deepEqual(r.items[0], { title: 'Starship flies', summary: 'It flew.', url: 'https://spacenews.com/a', image: 'https://img/a.jpg', date: '2026-10-01T08:00:00Z', date_local: '01.10, 11:00 (Київ)', extra: { news_site: 'SpaceNews' } });
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
  // Spec 063 FR-005 (pp1716): 15:00Z is 18:00 in Kyiv in October; the model never converts the zone.
  assert.equal(r.items[0].extra.ends_at_local, '02.10, 18:00 (Київ)');
  assert.equal(r.items[0].date_local, '25.09, 18:00 (Київ)');
});

const epicOf = (...elements: unknown[]) => ({ data: { Catalog: { searchStore: { elements } } } });
const offerOf = (startDate: string, endDate: string, pct: number) => ({ startDate, endDate, discountSetting: { discountPercentage: pct } });

test('spec 086 FR-001: epic_free_games lists free_now first, then upcoming with starts_at and the note; a sale never sets the deadline', async () => {
  const { call } = fakeHttp(() => ({ body: epicOf(
    { title: 'Next', productSlug: 'next', promotions: { promotionalOffers: [], upcomingPromotionalOffers: [{ promotionalOffers: [offerOf('2026-10-08T15:00:00Z', '2026-10-15T15:00:00Z', 0)] }] } },
    { title: 'Now', productSlug: 'now', promotions: { promotionalOffers: [{ promotionalOffers: [offerOf('2026-09-20T15:00:00Z', '2026-10-02T15:00:00Z', 50), offerOf('2026-09-25T15:00:00Z', '2026-10-05T15:00:00Z', 0)] }] } },
  ) }));
  const r = await call('epic_free_games');
  assert.deepEqual(r.items.map((i: any) => [i.title, i.extra.status]), [['Now', 'free_now'], ['Next', 'upcoming']]);
  assert.equal(r.items[0].extra.ends_at, '2026-10-05T15:00:00Z');
  assert.equal(r.items[0].extra.ends_at_local, '05.10, 18:00 (Київ)');
  assert.equal(r.items[1].extra.starts_at, '2026-10-08T15:00:00Z');
  assert.equal(r.items[1].extra.starts_at_local, '08.10, 18:00 (Київ)');
  assert.equal(r.items[1].date, '2026-10-08T15:00:00Z');
  assert.match(r.note, /status upcoming — гра ще не безкоштовна/);
  const none = fakeHttp(() => ({ body: epicOf({ title: 'Now', promotions: { promotionalOffers: [{ promotionalOffers: [offerOf('2026-09-25T15:00:00Z', '2026-10-05T15:00:00Z', 0)] }] } }) }));
  assert.equal((await none.call('epic_free_games')).note, undefined, 'no upcoming item, no note');
});

const GP = (o: Record<string, unknown>) => ({ id: 1, description: 'd', instructions: 'i', type: 'Game', gamerpower_url: 'https://gamerpower.com/1', image: '', published_date: '2026-09-30 10:00:00', status: 'Active', ...o });
const isEpicUrl = (u: URL) => u.hostname.includes('epicgames');

test('spec 086 FR-002: gamerpower_giveaways: 23:59 is a date; the Epic moment wins for an Epic giveaway; a failed Epic read keeps the date; non-Epic never reads Epic', async () => {
  const route = (epic: () => { status?: number; body: unknown }) => (u: URL) => isEpicUrl(u) ? epic() : { body: [
    GP({ title: 'Hogwarts Legacy (Epic Games) Giveaway', platforms: 'PC, Epic Games Store', end_date: '2026-10-05 23:59:00' }),
    GP({ id: 2, title: 'Other Game Giveaway', platforms: 'PC, Steam', end_date: '2026-10-05 23:59:00' }),
  ] };
  const epicBody = epicOf({ title: 'Hogwarts Legacy', promotions: { promotionalOffers: [{ promotionalOffers: [offerOf('2026-09-25T15:00:00Z', '2026-10-05T15:00:00Z', 0)] }] } });
  const ok = await fakeHttp(route(() => ({ body: epicBody }))).call('gamerpower_giveaways');
  assert.deepEqual([ok.items[0].extra.ends_at, ok.items[0].extra.ends_at_source, ok.items[0].extra.ends_at_local], ['2026-10-05T15:00:00Z', 'epic', '05.10, 18:00 (Київ)']);
  assert.deepEqual([ok.items[1].extra.ends_at, ok.items[1].extra.ends_at_source, ok.items[1].extra.ends_at_local], ['2026-10-05', 'gamerpower', undefined]);

  const down = await fakeHttp(route(() => ({ status: 503, body: {} }))).call('gamerpower_giveaways');
  assert.deepEqual([down.items[0].extra.ends_at, down.items[0].extra.ends_at_source], ['2026-10-05', 'gamerpower']);

  const plain = fakeHttp((u) => isEpicUrl(u) ? { body: epicBody } : { body: [GP({ title: 'Loot', platforms: 'PC, Steam', end_date: '2026-10-05 23:59' })] });
  await plain.call('gamerpower_giveaways');
  assert.ok(!plain.urls.some(isEpicUrl), 'a non-Epic result never triggers the Epic read');
});

test('spec 086 FR-003: steam_deals returns ends_at from discount_expiration, null without it', async () => {
  const { call } = fakeHttp(() => ({ body: { specials: { items: [
    { id: 1, name: 'A', discount_percent: 80, discount_expiration: 1793894400 },
    { id: 2, name: 'B', discount_percent: 80, discount_expiration: 0 },
    { id: 3, name: 'C', discount_percent: 80 },
  ] } } }));
  const r = await call('steam_deals', { enrich: false });
  assert.equal(r.items[0].extra.ends_at, '2026-11-05T16:00:00.000Z');
  assert.equal(r.items[0].extra.ends_at_local, '05.11, 18:00 (Київ)');
  assert.equal(r.items[1].extra.ends_at, null);
  assert.equal(r.items[2].extra.ends_at, null);
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

test('063: *_local fields — Kyiv wall clock for ISO instants (DST aware), GamerPower dates read as UTC, no twin for date-only values', async () => {
  const { kyivLocal, withLocalTimes } = await import('./local-time');
  assert.equal(kyivLocal('2026-10-22T15:00:00Z'), '22.10, 18:00 (Київ)');
  assert.equal(kyivLocal('2026-12-22T15:00:00Z'), '22.12, 17:00 (Київ)', 'winter time');
  assert.equal(kyivLocal('2026-10-22T15:00:00+00:00'), '22.10, 18:00 (Київ)');
  assert.equal(kyivLocal('2026-10-22T18:00:00+03:00'), '22.10, 18:00 (Київ)');
  assert.equal(kyivLocal('2026-10-22 23:59:00'), '23.10, 02:59 (Київ)', 'zoneless API time is UTC');
  assert.equal(kyivLocal('2026-10-22'), null);
  assert.equal(kyivLocal('N/A'), null);
  assert.equal(kyivLocal(5), null);
  assert.deepEqual(withLocalTimes({ ends_at: '2026-10-22T15:00:00Z', title: 'x', n: 1 }), { ends_at: '2026-10-22T15:00:00Z', ends_at_local: '22.10, 18:00 (Київ)', title: 'x', n: 1 });
  const { call } = fakeHttp(() => ({ body: [
    { id: 1, title: 'Loot', description: 'd', instructions: 'Claim', type: 'Loot', platforms: 'PC', end_date: '2026-10-25 12:00:00', gamerpower_url: 'https://gamerpower.com/1', image: '', published_date: '2026-09-30 10:00:00', status: 'Active' },
  ] }));
  const r = await call('gamerpower_giveaways');
  assert.equal(r.items[0].extra.ends_at_local, '25.10, 14:00 (Київ)', 'Kyiv leaves summer time on 25.10 at 04:00');
  assert.equal(r.items[0].date_local, '30.09, 13:00 (Київ)');
});
