import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCarouselRecipe, buildCarouselCaption, macrosLine } from './recipe-carousel.map';

function row(over = {}) {
  return {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'Французька',
    ingredients: null, instructions: null,
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Розтопіть масло.',
    telegraph_url: null, telegraph_path: null,
    kcal: '85', protein_g: '4', fat_g: '1', carbs_g: '15', serving_size_g: '258',
    ...over,
  } as any;
}

test('toCarouselRecipe maps fields and parses numeric strings', () => {
  const r = toCarouselRecipe(row());
  assert.equal(r.titleUk, 'Пом Анна');
  assert.equal(r.category, 'Французька');
  assert.equal(r.kcal, 85);
  assert.equal(r.proteinG, 4);
  assert.equal(r.ingredientsUk, 'Картопля — 1 кг');
  assert.equal(r.instructionsUk, '1. Розтопіть масло.');
});

test('toCarouselRecipe yields null for empty/missing numerics and uk fields', () => {
  const r = toCarouselRecipe(row({ kcal: '', protein_g: null, title_uk: null, ingredients_uk: null }));
  assert.equal(r.kcal, null);
  assert.equal(r.proteinG, null);
  assert.equal(r.titleUk, '');
  assert.equal(r.ingredientsUk, '');
});

test('macrosLine formats present macros and rounds kcal', () => {
  assert.equal(macrosLine(row({ kcal: '84.55' })), '🔥 85 ккал · Б 4 · Ж 1 · В 15 (на порцію)');
  assert.equal(macrosLine(row({ kcal: '', protein_g: null, fat_g: null, carbs_g: null })), '');
});

test('buildCarouselCaption includes title, cuisine, macros, and a CTA', () => {
  const c = buildCarouselCaption(row());
  assert.match(c, /Пом Анна/);
  assert.match(c, /🍽️ Французька/);
  assert.match(c, /🔥 85 ккал/);
  assert.match(c, /гортай/);
});

test('buildCarouselCaption omits cuisine and macros when absent', () => {
  const c = buildCarouselCaption(row({ category: null, kcal: '', protein_g: null, fat_g: null, carbs_g: null }));
  assert.doesNotMatch(c, /🍽️/);
  assert.doesNotMatch(c, /🔥/);
  assert.match(c, /Пом Анна/);
});
