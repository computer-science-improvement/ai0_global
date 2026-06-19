import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeCarouselStrategy } from './recipe-carousel.strategy';

function makeRow(over = {}) {
  return {
    id: 'r1', title: 'Pommes', image_url: 'https://x/i.jpg', category: 'Французька',
    ingredients: null, instructions: null,
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля', instructions_uk: '1.',
    telegraph_url: null, telegraph_path: null,
    kcal: '85', protein_g: '4', fat_g: '1', carbs_g: '15', serving_size_g: '258', ...over,
  };
}

const TT_DEST = { platform: 'tiktok', targetId: 'tt1', metaAccountId: null, postedKey: 'TT:tt1', throttleKey: 'tiktok:tt1' } as any;

function build(over: any = {}) {
  const calls: any = { rendered: null, renderOpts: null, uploaded: null, published: null, posted: [], deleted: [] };
  const repo = {
    getNextForCarousel: async () => ('row' in over ? over.row : makeRow()),
    markPosted: async (id: string, key: string) => { calls.posted.push([id, key]); },
  };
  const renderer = { render: async (recipe: any, _buf: any, opts: any) => { calls.rendered = recipe; calls.renderOpts = opts; return [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]; } };
  const hosting = {
    upload: async (slides: Buffer[], prefix: string) => { calls.uploaded = { count: slides.length, prefix }; return [{ url: 'u1', path: 'p1' }, { url: 'u2', path: 'p2' }, { url: 'u3', path: 'p3' }]; },
    delete: async (paths: string[]) => { calls.deleted = paths; },
  };
  const dispatcher = { publishCarousel: async () => { throw new Error('meta path must not be used for tiktok'); } };
  const images = { download: async () => over.image === null ? null : Buffer.from('img') };
  const registry = { register() {} };
  const tiktok = { publishCarousel: async (accountId: string, urls: string[], caption: string) => { calls.published = { accountId, urls, caption }; if (over.publishError) throw new Error(over.publishError); return 'pub_1'; } };
  const groupFanOut = { fanOut: async () => {} };
  const telegramPub = { publish: async () => 'mid' };
  const s = new RecipeCarouselStrategy(repo as any, renderer as any, hosting as any, dispatcher as any, images as any, registry as any, tiktok as any, groupFanOut as any, telegramPub as any, { resolveGroupTelegramLink: async () => null } as any, { span: (_s: any, _a: any, f: any) => f(), event() {}, steps: () => [], describeError: (e: any) => String(e?.message ?? e) } as any);
  return { s, calls };
}

test('tiktok branch renders 9:16, hosts, publishes via TikTokCarouselPublisher, dedups, deletes', async () => {
  const { s, calls } = build();
  await s.execute('', {}, TT_DEST);
  assert.deepEqual(calls.renderOpts, { width: 1080, height: 1920 });
  assert.equal(calls.uploaded.prefix, 'carousel/tiktok/tt1/r1');
  assert.equal(calls.published.accountId, 'tt1');
  assert.deepEqual(calls.published.urls, ['u1', 'u2', 'u3']);
  assert.match(calls.published.caption, /Пом Анна/);
  assert.deepEqual(calls.posted, [['r1', 'TT:tt1']]);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('tiktok publish error: no markPosted, slides deleted, throws', async () => {
  const { s, calls } = build({ publishError: 'rate limited' });
  await assert.rejects(() => s.execute('', {}, TT_DEST), /Carousel publish \(tiktok\)/);
  assert.equal(calls.posted.length, 0);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('tiktok branch: no eligible recipe returns without publishing', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('', {}, TT_DEST);
  assert.equal(calls.published, null);
  assert.equal(calls.posted.length, 0);
});
