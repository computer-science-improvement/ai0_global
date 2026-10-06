import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMapColumns, inferSchemaDraft, inferType, suggestFieldName } from './type-inference';
import { schemaInputSchema } from '../data.types';

test('inferType: one rule per type, first match wins', () => {
  assert.deepEqual(inferType(['1', '22', '-3', '']), { type: 'int' });
  assert.deepEqual(inferType(['1.5', '2', '3,25']), { type: 'number' });
  assert.deepEqual(inferType(['true', 'False', 'yes', 'NO']), { type: 'bool' });
  assert.deepEqual(inferType(['2024-02-29', '1991-08-24']), { type: 'date' });
  assert.deepEqual(inferType(['2024-02-30']), { type: 'text' }, 'an impossible date is not a date');
  assert.deepEqual(inferType(['2026-10-06T12:00:00Z', '2026-10-06 08:30']), { type: 'datetime' });
  assert.deepEqual(inferType(['08-24', '01-01']), { type: 'month_day' });
  assert.deepEqual(inferType(['https://x.ua/a.JPG', 'http://y.com/p/b.webp?w=1']), { type: 'image_url' });
  assert.deepEqual(inferType(['https://x.ua/a.jpg', 'https://x.ua/page']), { type: 'url' });
  assert.deepEqual(inferType(['soup', 'dessert', 'soup', 'soup']), { type: 'enum', enum: ['dessert', 'soup'] });
  assert.deepEqual(inferType(['a', 'b', 'c']), { type: 'text' }, 'values that never repeat are not an enum');
  assert.deepEqual(inferType(['x'.repeat(301), 'short']), { type: 'long_text' });
  assert.deepEqual(inferType([['a', 'b'], ['c']]), { type: 'text_list' });
  assert.deepEqual(inferType([{ a: 1 }]), { type: 'json' });
  assert.deepEqual(inferType([1, 2.5]), { type: 'number' });
  assert.deepEqual(inferType([1, 2]), { type: 'int' });
  assert.deepEqual(inferType([true, false]), { type: 'bool' });
  assert.deepEqual(inferType(['', null, undefined]), { type: 'text' });
  assert.deepEqual(inferType(['1', '0', '1', '1']), { type: 'int' }, '1/0 stays an int, not a bool');
});

test('inferType is deterministic: the same sample in another order gives the same enum', () => {
  assert.deepEqual(inferType(['b', 'a', 'b', 'a']), inferType(['a', 'b', 'a', 'b']));
});

test('suggestFieldName: snake_case, Ukrainian transliterated, unique', () => {
  assert.equal(suggestFieldName('Назва страви'), 'nazva_stravy');
  assert.equal(suggestFieldName('imageURL'), 'image_url');
  assert.equal(suggestFieldName('  Price (UAH) '), 'price_uah');
  assert.equal(suggestFieldName('2024 sales'), 'f_2024_sales');
  assert.equal(suggestFieldName('!!!'), 'field');
  assert.equal(suggestFieldName('Title', new Set(['title'])), 'title_2');
});

test('autoMapColumns: by normalised name, each field once, others null', () => {
  const fields = [{ name: 'title' }, { name: 'image_url' }, { name: 'kcal' }];
  assert.deepEqual(autoMapColumns(['Title', 'Image URL', 'imageUrl', 'other'], fields), {
    Title: 'title', 'Image URL': 'image_url', imageUrl: null, other: null,
  });
});

test('inferSchemaDraft: fields, roles, dedup key and a mapping that make a valid schema', () => {
  const cols = ['ID', 'Назва', 'Опис', 'Фото', 'Категорія', 'Дата'];
  const rows = Array.from({ length: 40 }, (_, i) => ({
    ID: String(i + 1), Назва: `Страва ${i}`, Опис: 'Довгий опис '.repeat(30), Фото: `https://img.example/${i}.jpg`,
    Категорія: i % 2 ? 'суп' : 'десерт', Дата: '2026-10-06',
  }));
  const d = inferSchemaDraft(cols, rows);
  assert.deepEqual(d.fields.map((f) => [f.name, f.type]), [
    ['id', 'int'], ['nazva', 'text'], ['opys', 'long_text'], ['foto', 'image_url'], ['katehoriia', 'enum'], ['data', 'date'],
  ]);
  assert.deepEqual(d.roles, { title: 'nazva', body: 'opys', image: 'foto', category: 'katehoriia', date: 'data' });
  assert.deepEqual(d.dedup_key, ['id']);
  assert.equal(d.mapping['Назва'], 'nazva');
  const ok = schemaInputSchema.safeParse({ key: 'dishes', title: 'Dishes', fields: d.fields, roles: d.roles, dedup_key: d.dedup_key });
  assert.equal(ok.success, true, JSON.stringify(!ok.success && ok.error.issues));
});

test('inferSchemaDraft: no unique key column → no dedup key', () => {
  const d = inferSchemaDraft(['name'], [{ name: 'a' }, { name: 'a' }]);
  assert.deepEqual(d.dedup_key, []);
});
