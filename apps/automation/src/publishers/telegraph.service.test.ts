import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitListItems, buildRecipeNodes, fmtNum, hasNutrition } from './telegraph.service';

test('splitListItems: drops blanks, trims, strips bullets', () => {
  const out = splitListItems('• Potato\n\n  - Butter \n* Salt');
  assert.deepEqual(out, ['Potato', 'Butter', 'Salt']);
});

test('splitListItems: stripOrdinal removes "1." / "2)" / "3 -"', () => {
  const out = splitListItems('1. Melt\n2) Slice\n3 - Bake', { stripOrdinal: true });
  assert.deepEqual(out, ['Melt', 'Slice', 'Bake']);
});

test('splitListItems: without stripOrdinal keeps numbers', () => {
  const out = splitListItems('1. Melt', {});
  assert.deepEqual(out, ['1. Melt']);
});

test('splitListItems: null/empty → []', () => {
  assert.deepEqual(splitListItems(null), []);
  assert.deepEqual(splitListItems(''), []);
});

test('buildRecipeNodes: figure+img, ul ingredients, ol instructions', () => {
  const nodes = buildRecipeNodes({
    title: 'Pommes Anna',
    category: 'French',
    ingredientsUk: 'Картопля — 1 кг\nМасло — 150 г',
    instructionsUk: '1. Розтопіть масло.\n2. Наріжте картоплю.',
    imageUrl: 'https://x/i.jpg',
  });
  // figure > img
  const figure = nodes.find((n: any) => n.tag === 'figure') as any;
  assert.ok(figure);
  assert.equal(figure.children[0].tag, 'img');
  assert.equal(figure.children[0].attrs.src, 'https://x/i.jpg');
  // ul with 2 items
  const ul = nodes.find((n: any) => n.tag === 'ul') as any;
  assert.equal(ul.children.length, 2);
  assert.deepEqual(ul.children[0], { tag: 'li', children: ['Картопля — 1 кг'] });
  // ol with 2 stripped steps
  const ol = nodes.find((n: any) => n.tag === 'ol') as any;
  assert.equal(ol.children.length, 2);
  assert.deepEqual(ol.children[0], { tag: 'li', children: ['Розтопіть масло.'] });
});

test('buildRecipeNodes: no image → no figure', () => {
  const nodes = buildRecipeNodes({
    title: 'X', category: null, ingredientsUk: 'A', instructionsUk: 'B', imageUrl: null,
  });
  assert.equal(nodes.find((n: any) => n.tag === 'figure'), undefined);
});

test('fmtNum rounds + handles null/strings', () => {
  assert.equal(fmtNum('84.55', 0), '85');
  assert.equal(fmtNum(4.43), '4.4');
  assert.equal(fmtNum(null), null);
  assert.equal(fmtNum(''), null);
  assert.equal(fmtNum('abc'), null);
});

test('hasNutrition: true only when a macro present', () => {
  assert.equal(hasNutrition(null), false);
  assert.equal(hasNutrition({ kcal: null, proteinG: null, fatG: null, carbsG: null, servingSizeG: 258 }), false);
  assert.equal(hasNutrition({ kcal: '84', proteinG: null, fatG: null, carbsG: null, servingSizeG: null }), true);
});

test('buildRecipeNodes: nutrition section with serving size header', () => {
  const nodes = buildRecipeNodes({
    title: 'X', category: null, ingredientsUk: 'A', instructionsUk: 'B', imageUrl: null,
    nutrition: { kcal: '84.55', proteinG: '4.43', fatG: '0.35', carbsG: '15.93', servingSizeG: '258' },
  });
  const txt = JSON.stringify(nodes);
  assert.ok(txt.includes('Харчова цінність (на порцію ~258 г)'));
  assert.ok(txt.includes('🔥 Калорійність: 85 ккал'));
  assert.ok(txt.includes('🥩 Білки: 4.4 г'));
  assert.ok(txt.includes('🍞 Вуглеводи: 15.9 г'));
});

test('buildRecipeNodes: no nutrition → no section', () => {
  const nodes = buildRecipeNodes({
    title: 'X', category: null, ingredientsUk: 'A', instructionsUk: 'B', imageUrl: null, nutrition: null,
  });
  assert.ok(!JSON.stringify(nodes).includes('Харчова цінність'));
});
