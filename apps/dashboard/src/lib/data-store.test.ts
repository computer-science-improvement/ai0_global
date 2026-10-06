// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilter, cellText, changeLabel, draftMapping, draftProblems, filterLabel, newField, opsForField, previewSummary, roleValueLabel,
  schemaPatch, type DraftField,
} from './data-store';

test('operators follow the backend rules per type; today needs a date-like type or role', () => {
  assert.deepEqual(opsForField({ name: 'genre', type: 'enum' }), ['eq', 'in', 'ilike', 'is_null']);
  assert.deepEqual(opsForField({ name: 'pages', type: 'int' }), ['eq', 'in', 'gte', 'lte', 'between', 'is_null']);
  assert.deepEqual(opsForField({ name: 'month', type: 'int' }, { month: 'month' }), ['eq', 'in', 'gte', 'lte', 'between', 'is_null', 'today']);
  assert.ok(opsForField({ name: 'd', type: 'month_day' }).includes('today'));
  assert.deepEqual(opsForField({ name: 'raw', type: 'json' }), ['is_null']);
});

test('filter values are typed from the inputs, with English errors', () => {
  assert.deepEqual(buildFilter({ name: 'pages', type: 'int' }, 'gte', ' 300 '), { field: 'pages', op: 'gte', value: 300 });
  assert.deepEqual(buildFilter({ name: 'pages', type: 'int' }, 'gte', '3.5'), { error: 'Enter a whole number' });
  assert.deepEqual(buildFilter({ name: 'rating', type: 'number' }, 'between', '4,5', '5'), { field: 'rating', op: 'between', value: [4.5, 5] });
  assert.deepEqual(buildFilter({ name: 'genre', type: 'enum' }, 'in', 'novel, poetry,'), { field: 'genre', op: 'in', value: ['novel', 'poetry'] });
  assert.deepEqual(buildFilter({ name: 'ok', type: 'bool' }, 'eq', 'Yes'), { field: 'ok', op: 'eq', value: true });
  assert.deepEqual(buildFilter({ name: 'd', type: 'date' }, 'eq', '2026/01/01'), { error: 'Use YYYY-MM-DD' });
  assert.deepEqual(buildFilter({ name: 'md', type: 'month_day' }, 'today', ''), { field: 'md', op: 'today' });
  assert.deepEqual(buildFilter({ name: 'cover', type: 'image_url' }, 'is_null', 'false'), { field: 'cover', op: 'is_null', value: false });
  assert.deepEqual(buildFilter({ name: 't', type: 'text' }, 'ilike', '  '), { error: 'Enter a value' });
});

test('filter chips read as English', () => {
  assert.equal(filterLabel({ field: 'genre', op: 'eq', value: 'novel' }), 'genre is novel');
  assert.equal(filterLabel({ field: 'pages', op: 'between', value: [1, 9] }), 'pages between 1 and 9');
  assert.equal(filterLabel({ field: 'cover', op: 'is_null', value: false }), 'cover is not empty');
  assert.equal(filterLabel({ field: 'ok', op: 'eq', value: true }), 'ok is yes');
  assert.equal(filterLabel({ field: 'md', op: 'today' }), 'md is today');
});

test('the edit preview names the version bump and the rows that keep the old version', () => {
  const base = { rows: 1240, rows_on_older_version: 1240, errors: [], changes: [{ kind: 'field_added', field: 'isbn' }] };
  assert.equal(previewSummary({ ...base, structural: true, nextVersion: 4 }, 3), 'Structural edit: version 3 → 4. 1,240 existing rows keep version 3 and stay valid.');
  assert.equal(previewSummary({ ...base, structural: true, nextVersion: 2, rows_on_older_version: 0, rows: 0 }, 1), 'Structural edit: version 1 → 2. The dataset has no rows yet.');
  assert.equal(previewSummary({ ...base, structural: false, nextVersion: 3, rows_on_older_version: 0 }, 3), 'Description-only edit: the dataset stays on version 3.');
  assert.equal(previewSummary({ ...base, structural: false, nextVersion: 3, changes: [] }, 3), 'Nothing changed.');
  assert.match(previewSummary({ ...base, structural: true, nextVersion: 4, errors: ['field "a" cannot be removed'] }, 3), /cannot be saved: field "a"/);
  assert.equal(changeLabel({ kind: 'field_added', field: 'isbn', detail: 'required only for rows written from the new version on' }),
    'New field "isbn" (required only for rows written from the new version on)');
  assert.equal(changeLabel({ kind: 'dataset_text', field: 'suitable_for' }), 'Dataset suitable for');
});

test('a drafted dataset maps columns to field names and lists what blocks creating it', () => {
  const fields: DraftField[] = [
    { column: 'Назва', name: 'nazva', type: 'text', description: '', include: true },
    { column: 'Junk', name: 'junk', type: 'text', description: '', include: false },
    { column: 'Kind', name: 'kind', type: 'enum', description: '', include: true },
  ];
  assert.deepEqual(draftMapping(fields), { 'Назва': 'nazva', Junk: null, Kind: 'kind' });
  assert.deepEqual(draftProblems({ key: 'Books', title: ' ', fields, dedup_key: ['junk'] }), [
    'Key: 2–63 characters, a-z, 0-9 and _, starting with a letter', 'Give the dataset a title',
    'Field "kind" is a list choice but has no values', 'Dedup key "junk" is not an included field',
  ]);
  assert.deepEqual(draftProblems({ key: 'books', title: 'Books', fields: [{ ...fields[0] }, { ...fields[0], column: 'b' }], dedup_key: [] }),
    ['Two fields are called "nazva"']);
});

test('the edit patch carries only changed keys; new fields are validated', () => {
  const saved = { title: 'Books', description: 'a', fields: [{ name: 'x', type: 'text' as const, description: '' }], roles: { title: 'x' } };
  assert.deepEqual(schemaPatch(saved, { ...saved, description: 'b' }), { description: 'b' });
  assert.equal(schemaPatch(saved, { ...saved, fields: [...saved.fields, { name: 'y', type: 'int' as const, description: '' }] }).fields?.length, 2);
  assert.deepEqual(schemaPatch(saved, { ...saved }), {});
  assert.deepEqual(newField(saved.fields, { name: 'x', type: 'text', description: '' }), { error: 'A field "x" already exists (deprecated fields keep their names)' });
  assert.deepEqual(newField(saved.fields, { name: 'Bad Name', type: 'text', description: '' }), { error: 'Field names are snake_case: a-z, 0-9 and _, starting with a letter' });
  assert.deepEqual(newField(saved.fields, { name: 'kind', type: 'enum', description: '', enumText: ' ' }), { error: 'List the allowed values, comma separated' });
  assert.deepEqual(newField(saved.fields, { name: 'kind', type: 'enum', description: ' Kind ', enumText: 'a, b, a' }),
    { name: 'kind', type: 'enum', description: 'Kind', required: false, agent_visible: true, searchable: false, filterable: false, enum: ['a', 'b'] });
});

test('small display helpers', () => {
  assert.equal(roleValueLabel(['title_uk', 'title']), 'title_uk, then title');
  assert.equal(roleValueLabel(undefined), '');
  assert.equal(cellText(['a', 'b']), 'a, b');
  assert.equal(cellText(null), '—');
  assert.equal(cellText('x'.repeat(10), 4), 'xxxx…');
  assert.equal(cellText({ a: 1 }), '{"a":1}');
});
