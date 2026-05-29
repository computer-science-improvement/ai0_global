import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesStrategy } from './recipes.strategy';

function makeRow(over = {}) {
  return {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'French',
    ingredients: 'Potato — 1 kg', instructions: '1. Melt butter.',
    title_uk: null, ingredients_uk: null, instructions_uk: null, ...over,
  };
}

function build(overrides = {}) {
  const calls = { chat: 0, save: [] as any[], posted: [] as string[], published: [] as any[] };
  const claude = { available: true, chat: async () => { calls.chat++; return JSON.stringify({
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Розтопіть масло.',
  }); }, ...((overrides as any).claude ?? {}) };
  const validator = { check: () => true, ...((overrides as any).validator ?? {}) };
  const registry = { register() {} };
  const publisher = { publishPrompt: async (p: any) => { calls.published.push(p); return '42'; } };
  const repo = {
    getNext: async () => ('row' in (overrides as any) ? (overrides as any).row : makeRow()),
    saveTranslation: async (id: string, t: any) => { calls.save.push({ id, t }); },
    markPosted: async (id: string) => { calls.posted.push(id); },
  };
  const notifier = { notifyPublished: async () => {} };
  const publications = { insert: async () => {} };
  const s = new RecipesStrategy(
    claude as any, validator as any, registry as any, publisher as any,
    repo as any, notifier as any, publications as any,
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

test('image download failure: no markPosted (retry next run)', async () => {
  const { s, calls } = build();
  (s as any).downloadImage = async () => { throw new Error('net'); };
  await s.execute('@chan', {});
  assert.equal(calls.published.length, 0);
  assert.equal(calls.posted.length, 0);
});

test('no unposted rows: no-op', async () => {
  const { s, calls } = build({ row: null });
  // getNext returns overrides.row which is null
  await s.execute('@chan', {});
  assert.equal(calls.published.length, 0);
});
