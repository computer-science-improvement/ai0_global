import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECIPE_TRANSLATE_PROMPT, buildRecipeTranslateUserMessage } from './recipe-translate.prompts';

test('translate system prompt demands strict JSON with the three _uk fields', () => {
  const s = RECIPE_TRANSLATE_PROMPT.system;
  assert.match(s, /title_uk/);
  assert.match(s, /ingredients_uk/);
  assert.match(s, /instructions_uk/);
  assert.match(s, /JSON/i);
});

test('user message carries the English source fields', () => {
  const msg = buildRecipeTranslateUserMessage({
    title: 'Classic Pommes Anna',
    category: 'French',
    ingredients: 'Potato — 1 kg',
    instructions: '1. Melt butter.',
  });
  assert.match(msg, /Classic Pommes Anna/);
  assert.match(msg, /French/);
  assert.match(msg, /Potato — 1 kg/);
  assert.match(msg, /Melt butter/);
});
