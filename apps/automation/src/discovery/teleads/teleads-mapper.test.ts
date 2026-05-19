import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTeleAdsProduct } from './teleads-mapper';
import { TeleAdsProduct } from './teleads.client';

const base: TeleAdsProduct = {
  id: 1179,
  slug: 'truexanewsua',
  link: 'https://t.me/truexanewsua',
  title: 'Труха',
  description: 'desc',
  source: 'Telegram',
  status: 'enabled',
  type: 'channel',
  language: 'ukrainian',
  sex: 'enabled',
  sex_ratio: 53,
  prices: [{ id: 1, type: '1day', price: 80000 }],
  categories: [{ id: 34, slug: 'novini-i-zmi', title: 'Новини і ЗМІ', status: 'enabled' }],
  avatar: null,
};

test('mapTeleAdsProduct: maps the happy path', () => {
  const row = mapTeleAdsProduct(base);
  assert.equal(row.source, 'teleads');
  assert.equal(row.external_id, '1179');
  assert.equal(row.slug, 'truexanewsua');
  assert.equal(row.title, 'Труха');
  assert.deepEqual(row.themes, ['novini-i-zmi']);
  assert.equal(row.sex_ratio, 53);
  assert.equal(row.price_min, 80000);
  assert.equal(row.price_max, 80000);
});

test('mapTeleAdsProduct: picks min and max across multiple price tiers', () => {
  const row = mapTeleAdsProduct({
    ...base,
    prices: [
      { id: 1, type: '1day', price: 80000 },
      { id: 2, type: '24h', price: 50000 },
      { id: 3, type: 'always', price: 200000 },
    ],
  });
  assert.equal(row.price_min, 50000);
  assert.equal(row.price_max, 200000);
});

test('mapTeleAdsProduct: handles empty prices array', () => {
  const row = mapTeleAdsProduct({ ...base, prices: [] });
  assert.equal(row.price_min, null);
  assert.equal(row.price_max, null);
});

test('mapTeleAdsProduct: sets sex_ratio to null when sex flag is disabled', () => {
  const row = mapTeleAdsProduct({ ...base, sex: 'disabled', sex_ratio: 53 });
  assert.equal(row.sex_ratio, null);
});

test('mapTeleAdsProduct: extracts 320x320 avatar when available', () => {
  const row = mapTeleAdsProduct({
    ...base,
    avatar: {
      media: {
        sizes: {
          '320x320': { url: 'https://cdn/big.webp', width: 320, height: 320 },
          '150x150': { url: 'https://cdn/small.webp', width: 150, height: 150 },
        },
      },
    },
  });
  assert.equal(row.avatar_url, 'https://cdn/big.webp');
});

test('mapTeleAdsProduct: falls back to any available avatar size', () => {
  const row = mapTeleAdsProduct({
    ...base,
    avatar: {
      media: {
        sizes: { '150x150': { url: 'https://cdn/x.webp', width: 150, height: 150 } },
      },
    },
  });
  assert.equal(row.avatar_url, 'https://cdn/x.webp');
});

test('mapTeleAdsProduct: returns null avatar when no avatar', () => {
  const row = mapTeleAdsProduct({ ...base, avatar: null });
  assert.equal(row.avatar_url, null);
});

test('mapTeleAdsProduct: captures all themes from categories', () => {
  const row = mapTeleAdsProduct({
    ...base,
    categories: [
      { id: 1, slug: 'a', title: 'A', status: 'enabled' },
      { id: 2, slug: 'b', title: 'B', status: 'enabled' },
    ],
  });
  assert.deepEqual(row.themes, ['a', 'b']);
});

test('mapTeleAdsProduct: filters out empty slugs from themes', () => {
  const row = mapTeleAdsProduct({
    ...base,
    categories: [
      { id: 1, slug: '', title: '', status: 'enabled' },
      { id: 2, slug: 'real', title: 'R', status: 'enabled' },
    ],
  });
  assert.deepEqual(row.themes, ['real']);
});

test('mapTeleAdsProduct: keeps raw_payload pointing at the full product', () => {
  const row = mapTeleAdsProduct(base);
  assert.equal(row.raw_payload, base);
});
