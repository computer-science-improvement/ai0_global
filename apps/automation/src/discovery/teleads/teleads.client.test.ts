import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpGet, TeleAdsClient } from './teleads.client';

const samplePage = {
  data: [{
    id: 1, slug: 'foo', link: 'https://t.me/foo', title: 'Foo', description: null,
    source: 'Telegram', status: 'enabled', type: 'channel', language: 'ukrainian',
    sex: 'enabled', sex_ratio: 60,
    prices: [{ id: 1, type: '1day', price: 50000 }],
    categories: [{ id: 16, slug: 'znamenitosti', title: 'Зн', status: 'enabled' }],
    avatar: null,
  }],
  meta: { current_page: 1, last_page: 1, total: 1, per_page: 100 },
  links: { first: '', last: '', prev: null, next: null },
};

interface Call { url: string; params: Record<string, string | number> }

function makeStub(responses: Array<{ status: number; data: any } | Error>) {
  const calls: Call[] = [];
  let idx = 0;
  const http: HttpGet = async (url, params) => {
    calls.push({ url, params });
    const r = responses[idx++ % responses.length];
    if (r instanceof Error) throw r;
    return r;
  };
  return { http, calls };
}

test('TeleAdsClient.listProducts: sends status=enabled, page, per_page', async () => {
  const { http, calls } = makeStub([{ status: 200, data: samplePage }]);
  const client = new TeleAdsClient(http);

  const page = await client.listProducts({ page: 1, perPage: 100 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://teleads.com.ua/api/promo/products/');
  assert.equal(calls[0].params.status, 'enabled');
  assert.equal(calls[0].params.page, 1);
  assert.equal(calls[0].params.per_page, 100);
  assert.equal(page.data[0].slug, 'foo');
});

test('TeleAdsClient.listProducts: appends filter=categories:ID; when categories provided', async () => {
  const { http, calls } = makeStub([{ status: 200, data: samplePage }]);
  const client = new TeleAdsClient(http);

  await client.listProducts({ page: 1, perPage: 50, categories: [16, 30] });

  assert.equal(calls[0].params.filter, 'categories:16,30;');
});

test('TeleAdsClient.listProducts: omits filter when categories empty', async () => {
  const { http, calls } = makeStub([{ status: 200, data: samplePage }]);
  const client = new TeleAdsClient(http);

  await client.listProducts({ page: 1, perPage: 50, categories: [] });

  assert.equal(calls[0].params.filter, undefined);
});

test('TeleAdsClient.listProducts: appends sorting when sort provided', async () => {
  const { http, calls } = makeStub([{ status: 200, data: samplePage }]);
  const client = new TeleAdsClient(http);

  await client.listProducts({ page: 1, perPage: 50, sort: 'reviews_count-desc' });

  assert.equal(calls[0].params.sorting, 'reviews_count-desc');
});

test('TeleAdsClient.listProducts: retries on 429 up to 3 times', async () => {
  const e429: any = new Error('rate limit');
  e429.response = { status: 429 };
  const { http, calls } = makeStub([e429, e429, { status: 200, data: samplePage }]);
  const client = new TeleAdsClient(http);

  const page = await client.listProducts({ page: 1, perPage: 10 });

  assert.equal(calls.length, 3);
  assert.equal(page.data[0].slug, 'foo');
});

test('TeleAdsClient.listProducts: gives up after 3 failed attempts', async () => {
  const e500: any = new Error('server error');
  e500.response = { status: 500 };
  const { http, calls } = makeStub([e500, e500, e500]);
  const client = new TeleAdsClient(http);

  await assert.rejects(client.listProducts({ page: 1, perPage: 10 }));
  assert.equal(calls.length, 3);
});

test('TeleAdsClient.listProducts: does not retry on 400', async () => {
  const e400: any = new Error('bad request');
  e400.response = { status: 400 };
  const { http, calls } = makeStub([e400]);
  const client = new TeleAdsClient(http);

  await assert.rejects(client.listProducts({ page: 1, perPage: 10 }));
  assert.equal(calls.length, 1);
});

test('TeleAdsClient.listCategories: returns the data array', async () => {
  const categoriesPayload = {
    data: [
      { id: 16, slug: 'znamenitosti', title: 'Зн', status: 'enabled' },
      { id: 30, slug: 'motivaciya-i-samorozvitok', title: 'Психологія', status: 'enabled' },
    ],
  };
  const { http } = makeStub([{ status: 200, data: categoriesPayload }]);
  const client = new TeleAdsClient(http);

  const cats = await client.listCategories();

  assert.equal(cats.length, 2);
  assert.equal(cats[0].slug, 'znamenitosti');
});
