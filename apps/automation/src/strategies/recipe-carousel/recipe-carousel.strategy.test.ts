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

const TG_DEST = {
  platform: 'telegram', targetId: 'c123', metaAccountId: null,
  postedKey: 'TELEGRAM', throttleKey: 'c123',
} as any;

function build(over: any = {}) {
  const calls: any = { rendered: null, uploaded: null, published: null, posted: [], deleted: [], downloaded: 0, fanOut: [], telegramPublished: null };
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
      const call = { platform, payload, urls, target };
      (calls.publishedAll ??= []).push(call);
      calls.published = call;
      if (over.publishError) throw new Error(over.publishError);
      return `post-${(calls.publishedAll).length}`;
    },
  };
  const images = { download: async () => { calls.downloaded++; return over.image === null ? null : Buffer.from('img'); } };
  const registry = { register() {} };
  const groupFanOut = {
    fanOut: async (source: any, content: any, markPosted: any) => {
      calls.fanOut.push({ source, content });
      if (over.fanOutError) throw new Error(over.fanOutError);
      // simulate calling markPosted for fan-out targets
      for (const key of (over.fanOutKeys ?? [])) {
        await markPosted(key);
      }
    },
  };
  const telegramPub = {
    publish: async (payload: any, target: any) => {
      calls.telegramPublished = { payload, target };
      if (over.telegramError) throw new Error(over.telegramError);
      return 'tg-mid-1';
    },
  };
  const s = new RecipeCarouselStrategy(
    repo as any, renderer as any, hosting as any, dispatcher as any, images as any, registry as any,
    { publishCarousel: async () => 'x' } as any,
    groupFanOut as any,
    telegramPub as any,
    { resolveGroupTelegramLink: async () => over.telegramLink ?? null } as any,
  );
  return { s, calls };
}

test('happy path: render → upload → publishCarousel → markPosted → fanOut → delete', async () => {
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
  // primary markPosted + no fan-out keys → just the primary
  assert.deepEqual(calls.posted, [['r1', 'IG:acc1']]);
  // groupFanOut.fanOut called once with correct args
  assert.equal(calls.fanOut.length, 1);
  assert.equal(calls.fanOut[0].source.platform, 'instagram');
  assert.deepEqual(calls.fanOut[0].content.imageUrls, ['u1', 'u2', 'u3']);
  assert.equal(calls.fanOut[0].content.carousel, true);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('no eligible recipe: returns without rendering or publishing', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('', {}, IG_DEST);
  assert.equal(calls.rendered, null);
  assert.equal(calls.published, null);
  assert.equal(calls.posted.length, 0);
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

// ── groupFanOut integration ───────────────────────────────────────────────────

test('meta publish calls groupFanOut.fanOut with correct content', async () => {
  const { s, calls } = build({ fanOutKeys: ['IG:ig-acc', 'TH:th-acc'] });
  await s.execute('', {}, {
    platform: 'facebook', targetId: 'FB1', token: 'fbtok',
    metaAccountId: 'fb-acc', postedKey: 'FB:fb-acc', throttleKey: 'meta:fb-acc',
  } as any);

  assert.equal(calls.fanOut.length, 1);
  assert.equal(calls.fanOut[0].source.platform, 'facebook');
  assert.deepEqual(calls.fanOut[0].content.imageUrls, ['u1', 'u2', 'u3']);
  assert.equal(calls.fanOut[0].content.carousel, true);
  assert.match(calls.fanOut[0].content.caption, /Пом Анна/);
  // primary + two fan-out keys via markPosted callback
  assert.deepEqual(calls.posted, [['r1', 'FB:fb-acc'], ['r1', 'IG:ig-acc'], ['r1', 'TH:th-acc']]);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('fanOut error does NOT prevent slides being deleted (fanOut throws inside try → caught)', async () => {
  const { s, calls } = build({ fanOutError: 'fan-out exploded' });
  // fanOut error propagates out (it's in the try block and we don't swallow it)
  await assert.rejects(() => s.execute('', {}, IG_DEST), /fan-out exploded/);
  // slides still deleted in finally
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

// ── Telegram source branch ────────────────────────────────────────────────────

test('telegram source: renders cover → uploads → publishes to telegram → fanOut → delete', async () => {
  const { s, calls } = build({ fanOutKeys: ['IG:ig-acc'] });
  await s.execute('', {}, TG_DEST);

  // rendered
  assert.equal(calls.rendered.titleUk, 'Пом Анна');
  assert.equal(calls.uploaded.prefix, 'carousel/telegram/c123/r1');
  // telegram published with cover URL
  assert.ok(calls.telegramPublished);
  assert.equal(calls.telegramPublished.payload.imageUrl, 'u1');
  assert.equal(calls.telegramPublished.target.id, 'c123');
  assert.match(calls.telegramPublished.payload.text, /Пом Анна/);
  // dedup marked for telegram first, then fan-out key
  assert.deepEqual(calls.posted, [['r1', 'TELEGRAM'], ['r1', 'IG:ig-acc']]);
  // fanOut called once
  assert.equal(calls.fanOut.length, 1);
  assert.equal(calls.fanOut[0].source.platform, 'telegram');
  // slides cleaned up
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('telegram source: no eligible recipe returns without publishing', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('', {}, TG_DEST);
  assert.equal(calls.rendered, null);
  assert.equal(calls.telegramPublished, null);
  assert.equal(calls.posted.length, 0);
});

test('telegram source: image download fails → throws, slides not uploaded', async () => {
  const { s, calls } = build({ image: null });
  await assert.rejects(() => s.execute('', {}, TG_DEST), /image download failed/i);
  assert.equal(calls.uploaded, null);
  assert.equal(calls.telegramPublished, null);
  assert.equal(calls.posted.length, 0);
});

test('telegram source publish error: throws, slides deleted', async () => {
  const { s, calls } = build({ telegramError: 'bot blocked' });
  await assert.rejects(() => s.execute('', {}, TG_DEST), /Carousel publish \(telegram\)/);
  assert.equal(calls.posted.length, 0);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('no dest: warns and returns without touching repo', async () => {
  const { s, calls } = build();
  await s.execute('', {}, undefined);
  assert.equal(calls.rendered, null);
  assert.equal(calls.posted.length, 0);
});
