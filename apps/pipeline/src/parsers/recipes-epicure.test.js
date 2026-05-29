import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, buildIngredientsText, buildInstructionsText, mapRecipe, normalizeAll,
} from './recipes-epicure.js';

const RAW = {
  recipe_name: 'Classic Pommes Anna',
  image_url: 'https://x/img.jpg',
  dish_type: 'main',
  flavor_profile: 'savory',
  cuisine_type: 'French',
  hero_ingredient: 'Potato',
  visual_description: 'Golden-brown.',
  ingredients: [{ name: 'Potato', quantity: '1 kg' }, { name: 'Butter', quantity: '150 g' }],
  instructions: ['Melt butter.', 'Slice potato.'],
};

test('slugify lowercases, strips punctuation, dashes spaces', () => {
  assert.equal(slugify('Classic Pommes Anna!'), 'classic-pommes-anna');
});

test('buildIngredientsText joins "name — quantity" per line', () => {
  assert.equal(buildIngredientsText(RAW.ingredients), 'Potato — 1 kg\nButter — 150 g');
});

test('buildInstructionsText numbers steps', () => {
  assert.equal(buildInstructionsText(RAW.instructions), '1. Melt butter.\n2. Slice potato.');
});

test('mapRecipe maps all fields onto the normalized shape', () => {
  const r = mapRecipe(RAW);
  assert.equal(r.title, 'Classic Pommes Anna');
  assert.equal(r.slug, 'classic-pommes-anna');
  assert.equal(r.description, 'Golden-brown.');
  assert.equal(r.ingredients, 'Potato — 1 kg\nButter — 150 g');
  assert.equal(r.instructions, '1. Melt butter.\n2. Slice potato.');
  assert.equal(r.image_url, 'https://x/img.jpg');
  assert.equal(r.category, 'French');
  assert.deepEqual(r.tags, ['main', 'savory', 'french', 'potato']);
  assert.equal(r.post_text, null);
  assert.deepEqual(r.raw, RAW); // full source object preserved losslessly
});

test('normalizeAll drops malformed entries and exact dupes, uniquifies slug collisions', () => {
  const a = { ...RAW };
  const aDupe = { ...RAW };                       // same name + image -> dropped
  const b = { ...RAW, image_url: 'https://x/2.jpg' }; // same name, diff image -> kept, unique slug
  const bad = { image_url: 'https://x/3.jpg' };   // no recipe_name -> dropped
  const { recipes, skipped } = normalizeAll([a, aDupe, b, bad]);
  assert.equal(recipes.length, 2);
  assert.equal(skipped, 1);
  assert.notEqual(recipes[0].slug, recipes[1].slug);
});
