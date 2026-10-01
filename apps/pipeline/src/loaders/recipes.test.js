import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, REFRESH_COLUMNS, PRESERVED_COLUMNS, freshRefusal } from './recipes.js';

test('freshRefusal: refresh needs ALLOW_TRUNCATE=yes', () => {
  assert.match(freshRefusal({}), /ALLOW_TRUNCATE=yes/);
  assert.match(freshRefusal({ ALLOW_TRUNCATE: '1' }), /ALLOW_TRUNCATE=yes/);
  assert.equal(freshRefusal({ ALLOW_TRUNCATE: 'yes' }), null);
});

test('refresh never overwrites translations, Telegraph pages or posted state', () => {
  for (const col of ['posted', 'title_uk', 'ingredients_uk', 'instructions_uk', 'translated_at', 'telegraph_url', 'telegraph_path']) {
    assert.ok(PRESERVED_COLUMNS.includes(col), `${col} must be preserved`);
    assert.ok(!REFRESH_COLUMNS.includes(col), `${col} must not be in the refresh SET list`);
  }
});

test('refresh updates the source columns (and only columns the loader inserts)', () => {
  for (const col of ['title', 'description', 'ingredients', 'instructions', 'image_url', 'kcal', 'raw']) {
    assert.ok(REFRESH_COLUMNS.includes(col), `${col} should be refreshed`);
  }
  for (const col of REFRESH_COLUMNS) assert.ok(COLUMNS.includes(col), `${col} is not an inserted column`);
  // The conflict key itself is never in the SET list.
  assert.ok(!REFRESH_COLUMNS.includes('slug'));
});
