import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeCarouselStrategy } from './recipe-carousel.strategy';

function makeRow(over = {}) {
  return {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'Французька',
    ingredients: null, instructions: null,
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля', instructions_uk: '1. Розтопіть',
    telegraph_url: null, telegraph_path: null,
    kcal: '85', protein_g: '4', fat_g: '1', carbs_g: '15', serving_size_g: '258',
    ...over,
  };
}

const IG_DEST = {
  platform: 'instagram', targetId: 'IG1', token: 'tok',
  metaAccountId: 'acc1', postedKey: 'IG:acc1', throttleKey: 'meta:acc1',
} as any;

function build(over: any = {}) {
  const calls: any = { rendered: null, uploaded: null, published: null, posted: [], deleted: [], downloaded: 0 };
  const repo = {
    getNextForCarousel: async () => ('row' in over ? over.row : makeRow()),
    markPosted: async (id: string, key: string) => { calls.posted.push([id, key]); },
  };
  const renderer = {
    render: async (recipe: any) => { calls.rendered = recipe; return [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]; },
  };
  const hosting = {
    available: async () => true,
    upload: async (slides: Buffer[], prefix: string) => {
      calls.uploaded = { count: slides.length, prefix };
      return [{ url: 'u1', path: 'p1' }, { url: 'u2', path: 'p2' }, { url: 'u3', path: 'p3' }];
    },
    delete: async (paths: string[]) => { calls.deleted = paths; },
  };
  const dispatcher = {
    publishCarousel: async (platform: string, payload: any, urls: string[], target: any) => {
      calls.published = { platform, payload, urls, target };
      if (over.publishError) throw new Error(over.publishError);
      return 'post-1';
    },
  };
  const images = { download: async () => { calls.downloaded++; return over.image === null ? null : Buffer.from('img'); } };
  const registry = { register() {} };
  const s = new RecipeCarouselStrategy(
    repo as any, renderer as any, hosting as any, dispatcher as any, images as any, registry as any,
    { publishCarousel: async () => 'x' } as any,
  );
  return { s, calls };
}

test('happy path: render → upload → publishCarousel → markPosted → delete', async () => {
  const { s, calls } = build();
  await s.execute('', {}, IG_DEST);

  assert.equal(calls.rendered.titleUk, 'Пом Анна');
  assert.equal(calls.uploaded.count, 3);
  assert.equal(calls.uploaded.prefix, 'carousel/instagram/acc1/r1');
  assert.equal(calls.published.platform, 'instagram');
  assert.deepEqual(calls.published.urls, ['u1', 'u2', 'u3']);
  assert.equal(calls.published.target.id, 'IG1');
  assert.equal(calls.published.target.token, 'tok');
  assert.match(calls.published.payload.text, /Пом Анна/);
  assert.deepEqual(calls.published.payload.tags, ['Французька']);
  assert.deepEqual(calls.posted, [['r1', 'IG:acc1']]);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('no eligible recipe: returns without rendering or publishing', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('', {}, IG_DEST);
  assert.equal(calls.rendered, null);
  assert.equal(calls.published, null);
  assert.equal(calls.posted.length, 0);
});

test('telegram destination: returns without touching the repo', async () => {
  const { s, calls } = build();
  await s.execute('', {}, { platform: 'telegram', targetId: 'c', metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: 'c' } as any);
  assert.equal(calls.rendered, null);
  assert.equal(calls.published, null);
});

test('image download fails: throws, no upload/publish/markPosted', async () => {
  const { s, calls } = build({ image: null });
  await assert.rejects(() => s.execute('', {}, IG_DEST), /image download failed/i);
  assert.equal(calls.uploaded, null);
  assert.equal(calls.published, null);
  assert.equal(calls.posted.length, 0);
});

test('transient publish error: no markPosted, slides deleted, throws', async () => {
  const { s, calls } = build({ publishError: 'rate limited' });
  await assert.rejects(() => s.execute('', {}, IG_DEST), /Carousel publish/);
  assert.equal(calls.posted.length, 0);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('permanent media error: markPosted (advance queue), slides deleted, throws', async () => {
  const { s, calls } = build({ publishError: 'Unsupported aspect ratio' });
  await assert.rejects(() => s.execute('', {}, IG_DEST), /Carousel publish/);
  assert.deepEqual(calls.posted, [['r1', 'IG:acc1']]);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});
