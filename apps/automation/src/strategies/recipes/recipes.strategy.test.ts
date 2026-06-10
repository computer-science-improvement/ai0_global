import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesStrategy } from './recipes.strategy';

function makeRow(over = {}) {
  return {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'French',
    ingredients: 'Potato — 1 kg', instructions: '1. Melt butter.',
    title_uk: null, ingredients_uk: null, instructions_uk: null,
    telegraph_url: null, telegraph_path: null,
    kcal: '84.55', protein_g: '4.43', fat_g: '0.35', carbs_g: '15.93', serving_size_g: '258',
    ...over,
  };
}

function build(overrides = {}) {
  const calls = {
    chat: 0, save: [] as any[], posted: [] as string[], published: [] as any[],
    pages: [] as any[], tgSaved: [] as any[], crossPost: null as any,
  };
  const claude = { available: true, chat: async () => { calls.chat++; return JSON.stringify({
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Розтопіть масло.',
  }); }, ...((overrides as any).claude ?? {}) };
  const validator = { check: () => true, ...((overrides as any).validator ?? {}) };
  const registry = { register() {} };
  const publisher = { publishPrompt: async (p: any) => { calls.published.push(p); return '42'; } };
  // Default: Telegraph unavailable → strategy uses the inline caption+reply path.
  const telegraph = {
    available: async () => false,
    createPage: async (a: any) => { calls.pages.push(a); return { url: 'https://telegra.ph/x', path: 'x' }; },
    ...((overrides as any).telegraph ?? {}),
  };
  const repo = {
    getNext: async () => ('row' in (overrides as any) ? (overrides as any).row : makeRow()),
    saveTranslation: async (id: string, t: any) => { calls.save.push({ id, t }); },
    saveTelegraph: async (id: string, p: any) => { calls.tgSaved.push({ id, p }); },
    markPosted: async (id: string) => { calls.posted.push(id); },
  };
  const notifier = { notifyPublished: async () => {} };
  const publications = { insert: async () => {} };
  const crossPost = { afterPublish: async (i: any) => { calls.crossPost = i; } };
  const s = new RecipesStrategy(
    claude as any, validator as any, registry as any, publisher as any,
    telegraph as any, repo as any, notifier as any, publications as any,
    crossPost as any,
  );
  // Avoid network in tests.
  (s as any).downloadImage = async () => Buffer.from('img');
  return { s, calls };
}

test('untranslated row: translates once, caches, publishes, marks posted', async () => {
  const { s, calls } = build();
  await s.execute('@chan', {});
  assert.equal(calls.chat, 1);
  assert.equal(calls.save.length, 1);
  assert.equal(calls.published.length, 1);
  const pub = calls.published[0];
  assert.ok(pub.caption.includes('Пом Анна'));
  assert.ok(pub.caption.includes('Картопля — 1 кг'));
  assert.ok(pub.replyText.includes('Розтопіть масло'));
  assert.deepEqual(calls.posted, ['r1']);
  assert.ok(calls.crossPost.teaser, 'teaser payload present');
  assert.ok(calls.crossPost.mirror, 'mirror payload present (enables Instagram)');
  assert.equal(calls.crossPost.mirror.imageUrl, 'https://x/i.jpg');
  assert.ok(calls.crossPost.mirror.text.length > 0);
});

test('already-translated row: does NOT call Claude', async () => {
  const row = makeRow({ title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Готуйте.' });
  const { s, calls } = build({ row });
  await s.execute('@chan', {});
  assert.equal(calls.chat, 0);
  assert.equal(calls.published.length, 1);
  assert.deepEqual(calls.posted, ['r1']);
});

test('SKIP_POST: writes empty sentinel, no publish, no markPosted', async () => {
  const { s, calls } = build({ claude: { available: true, chat: async () => 'SKIP_POST' } });
  await s.execute('@chan', {});
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].t.titleUk, '');
  assert.equal(calls.published.length, 0);
  assert.equal(calls.posted.length, 0);
});

test('image download failure: translation cached, no markPosted (retry next run)', async () => {
  const { s, calls } = build();
  (s as any).downloadImage = async () => { throw new Error('net'); };
  await s.execute('@chan', {});
  assert.equal(calls.save.length, 1);   // translation persisted so retry doesn't re-pay Claude
  assert.equal(calls.published.length, 0);
  assert.equal(calls.posted.length, 0);
});

test('claude unavailable: no Claude call, no sentinel, no publish', async () => {
  const { s, calls } = build({ claude: { available: false, chat: async () => '' } });
  await s.execute('@chan', {});
  assert.equal(calls.chat, 0);
  assert.equal(calls.save.length, 0);   // no sentinel — retry when Claude is back
  assert.equal(calls.published.length, 0);
  assert.equal(calls.posted.length, 0);
});

test('no unposted rows: no-op', async () => {
  const { s, calls } = build({ row: null });
  // getNext returns overrides.row which is null
  await s.execute('@chan', {});
  assert.equal(calls.published.length, 0);
});

test('telegraph available: creates page once, short caption + link, no reply', async () => {
  const { s, calls } = build({
    telegraph: {
      available: async () => true,
      createPage: async (a: any) => { calls.pages.push(a); return { url: 'https://telegra.ph/Pommes-06-04', path: 'Pommes-06-04' }; },
    },
  });
  await s.execute('@chan', {});
  assert.equal(calls.pages.length, 1);                 // page created
  assert.deepEqual(calls.tgSaved.map(t => t.id), ['r1']); // url cached
  const pub = calls.published[0];
  assert.ok(pub.caption.includes('Пом Анна'));
  assert.ok(pub.caption.includes('telegra.ph/Pommes-06-04'));
  assert.ok(pub.caption.includes('Повний рецепт'));
  assert.ok(pub.caption.includes('ккал'));             // per-serving macros in caption
  assert.equal(pub.replyText, undefined);              // instructions live on the page
  // Nutrition section is part of the Telegraph article nodes.
  const nodeText = JSON.stringify(calls.pages[0].nodes);
  assert.ok(nodeText.includes('Харчова цінність'));
  assert.ok(nodeText.includes('Білки'));
  assert.deepEqual(calls.posted, ['r1']);
});

test('telegraph cached on row: reuse url, no createPage', async () => {
  const row = makeRow({ telegraph_url: 'https://telegra.ph/Cached-01-01', telegraph_path: 'Cached-01-01' });
  const { s, calls } = build({ row, telegraph: { available: async () => true } });
  await s.execute('@chan', {});
  assert.equal(calls.pages.length, 0);                 // not re-created
  assert.ok(calls.published[0].caption.includes('telegra.ph/Cached-01-01'));
  assert.deepEqual(calls.posted, ['r1']);
});

test('telegraph createPage throws: falls back to inline caption + reply', async () => {
  const { s, calls } = build({
    telegraph: {
      available: async () => true,
      createPage: async () => { throw new Error('telegraph 500'); },
    },
  });
  await s.execute('@chan', {});
  const pub = calls.published[0];
  assert.ok(pub.caption.includes('Картопля — 1 кг')); // inline ingredients
  assert.ok(pub.replyText.includes('Розтопіть масло')); // inline instructions
  assert.deepEqual(calls.posted, ['r1']);
});
