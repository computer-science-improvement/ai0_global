import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apodPageUrl, mapApod } from './nasa-apod.api';
import { mapSpaceflightArticles, spaceflightArticlesUrl } from './spaceflight-news.api';
import { mapTmdbTrending, tmdbTrendingUrl } from './tmdb.api';
import { mapEpicFreeGames, mapGamerPowerGiveaways, mapSteamDeal, steamSpecials } from './games.api';
import { byabbeUrl, mapByabbeEntries } from './byabbe.api';

const NOW = Date.parse('2026-10-01T12:00:00Z');

test('mapApod: image day mapped, video day → null; page url', () => {
  const it = mapApod({ media_type: 'image', title: 'Ring', explanation: 'x', url: 'https://apod/i.jpg', date: '2026-10-01', copyright: 'A' });
  assert.equal(it?.imageUrl, 'https://apod/i.jpg');
  assert.equal(it?.hdUrl, null);
  assert.equal(mapApod({ media_type: 'video' }), null);
  assert.equal(apodPageUrl('2026-10-01'), 'https://apod.nasa.gov/apod/ap261001.html');
});

test('mapSpaceflightArticles maps results and tolerates empty', () => {
  assert.deepEqual(mapSpaceflightArticles({ results: [] }), []);
  const [a] = mapSpaceflightArticles({ results: [{ id: 1, title: 'T', url: 'https://u', image_url: 'https://i', summary: 'S', published_at: '2026' }] });
  assert.deepEqual(a, { title: 'T', description: 'S', source: 'https://u', imageUrl: 'https://i', publishedAt: '2026', contentType: 'news' });
  assert.match(spaceflightArticlesUrl(5), /limit=5&ordering=-published_at/);
});

test('mapTmdbTrending: tv/movie fields, vote filter, genres', () => {
  const items = mapTmdbTrending([
    { id: 1, media_type: 'tv', name: 'Show', original_name: 'Show', first_air_date: '2026-01-01', overview: 'o', vote_count: 60, genre_ids: [18], poster_path: '/p.jpg' },
    { id: 2, media_type: 'movie', title: 'Low', overview: 'o', vote_count: 3 },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'https://www.themoviedb.org/tv/1');
  assert.deepEqual(items[0].genreNames, ['Drama']);
  assert.equal(items[0].imageUrl, 'https://image.tmdb.org/t/p/w500/p.jpg');
  assert.equal(tmdbTrendingUrl('movie', 'day'), 'https://api.themoviedb.org/3/trending/movie/day');
});

test('mapEpicFreeGames keeps only currently-free offers', () => {
  const offer = (start: string, end: string, pct: number) => ({ promotionalOffers: [{ startDate: start, endDate: end, discountSetting: { discountPercentage: pct } }] });
  const items = mapEpicFreeGames([
    { title: 'Free', productSlug: 'free', keyImages: [{ type: 'Thumbnail', url: 'https://t' }], promotions: { promotionalOffers: [offer('2026-09-25', '2026-10-02', 0)] } },
    { title: 'Discounted', promotions: { promotionalOffers: [offer('2026-09-25', '2026-10-02', 50)] } },
    { title: 'Expired', promotions: { promotionalOffers: [offer('2026-09-01', '2026-09-08', 0)] } },
  ], NOW);
  assert.deepEqual(items.map((i) => i.title), ['Free']);
  assert.equal(items[0].source, 'https://store.epicgames.com/en-US/p/free');
  assert.equal(items[0].imageUrl, 'https://t');
});

test('mapGamerPowerGiveaways drops inactive and ended', () => {
  const base = { id: 1, description: 'd', instructions: 'i', type: 'Game', platforms: 'PC', gamerpower_url: 'https://g', image: '', published_date: '2026-09-30' };
  const items = mapGamerPowerGiveaways([
    { ...base, title: 'A', status: 'Active', end_date: 'N/A' },
    { ...base, title: 'B', status: 'Active', end_date: '2026-09-01 00:00:00' },
    { ...base, title: 'C', status: 'Expired', end_date: 'N/A' },
  ] as any, NOW);
  assert.deepEqual(items.map((i) => i.title), ['A']);
  assert.equal(items[0].imageUrl, null);
  assert.equal(items[0].endDate, undefined);
});

test('steamSpecials + mapSteamDeal: discount filter, prices, requirements', () => {
  const specials = steamSpecials({ specials: { items: [{ id: 10, discount_percent: 75 }, { id: 11, discount_percent: 20 }] } });
  assert.deepEqual(specials.map((s) => s.id), [10]);
  const deal = mapSteamDeal(
    { id: 10, name: 'Game', discount_percent: 75, final_price: 499, original_price: 1999, currency: 'USD', header_image: 'https://h' },
    { short_description: 'sd', genres: [{ description: 'RPG' }], pc_requirements: { minimum: '<strong>Memory:</strong> 8 GB RAM<br>' } },
    { review_score_desc: 'Very Positive', total_reviews: 100 },
  );
  assert.equal(deal.salePrice, '4.99 USD');
  assert.equal(deal.origPrice, '19.99 USD');
  assert.equal(deal.minRam, '8 GB RAM');
  assert.equal(deal.source, 'https://store.steampowered.com/app/10');
});

test('mapByabbeEntries limits and falls back to the wikipedia title', () => {
  const out = mapByabbeEntries([{ year: 1991, description: 'A' }, { year: '1500', wikipedia: [{ title: 'B' }] }, { year: 1 }], 2);
  assert.deepEqual(out, [{ year: '1991', description: 'A' }, { year: '1500', description: 'B' }]);
  assert.equal(byabbeUrl(10, 1, 'births'), 'https://byabbe.se/on-this-day/10/1/births.json');
});
