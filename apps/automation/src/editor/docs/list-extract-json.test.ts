import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractError, extractRow, extractValue, filterEntries, jsonEntries, parsePath } from './list-extract';
import { entriesOf } from './list-extract';
import { parseMarkdown } from './markdown-doc';
import { promptschatPage } from './testing/promptschat-fixture';
import type { StoredDoc } from './doc-types';

const records = (promptschatPage(1).prompts as unknown[]).concat(promptschatPage(2).prompts as unknown[]);
const entries = jsonEntries(records);
const byTitle = (t: string) => entries.find((e) => e.heading === t)!;
const sarcasm = byTitle('Sarcasm');
const puffin = entries.find((e) => e.heading.startsWith('Photoreal'))!;
const vault = byTitle('Prompt Vault Manager');

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof ExtractError ? e.code : 'other'; }
  return undefined;
};

test('field: a dot path, an array index and [] that maps and joins', () => {
  assert.equal(extractValue('field:title', sarcasm), 'Sarcasm');
  assert.equal(extractValue('field:author.name', sarcasm), 'Robert Roquet');
  assert.equal(extractValue('field:category.slug', puffin), 'image-generation');
  assert.equal(extractValue('field:tags[0].tag.name', puffin), 'Photography');
  assert.equal(extractValue('field:tags[].tag.name', puffin), 'Photography, Realism, Travel');
  assert.equal(extractValue('field:tags[].tag.name', sarcasm), null, 'an empty array has no value');
  assert.equal(extractValue('field:tags[7].tag.name', puffin), null, 'an index past the end');
  assert.equal(extractValue('field:content', sarcasm), 'I will provide comments. I may offer my own views on those comments.\nRespond with sarcasm: dry, short, never cruel.', 'the prompt keeps its line breaks');
  assert.match(extractValue('field:mediaUrl', puffin)!, /puffins\.jpg$/);
});

test('field: numbers and booleans become strings; null, blank, missing and objects are no value', () => {
  const [e] = jsonEntries([{ n: 5, z: 0, t: true, f: false, nil: null, blank: '  ', obj: { a: 1 }, list: ['a', '', 'b'], nested: { deep: [{ v: 1 }, { v: 2 }] } }]);
  assert.equal(extractValue('field:n', e), '5');
  assert.equal(extractValue('field:z', e), '0', 'zero is a value');
  assert.equal(extractValue('field:t', e), 'true');
  assert.equal(extractValue('field:f', e), 'false');
  assert.equal(extractValue('field:nil', e), null);
  assert.equal(extractValue('field:blank', e), null);
  assert.equal(extractValue('field:missing.deeper', e), null);
  assert.equal(extractValue('field:obj', e), null, 'an object is not a text value');
  assert.equal(extractValue('field:list', e), 'a, b', 'an array of scalars joins');
  assert.equal(extractValue('field:nested.deep[].v', e), '1, 2');
});

test('first_of takes the first path that has a value; const and regex work as for markdown', () => {
  assert.equal(extractValue('first_of:author.name|author.username', sarcasm), 'Robert Roquet');
  assert.equal(extractValue('first_of:author.name|author.username', vault), 'dillonbowen123', 'a name-less author falls back to the username');
  assert.equal(extractValue('first_of:nope|alsono', vault), null);
  assert.equal(extractValue('const:CC BY 4.0', sarcasm), 'CC BY 4.0');
  assert.equal(extractValue('regex:"slug": "([^"]+)"', sarcasm), 'sarcasm', 'over the record\'s JSON text, first group');
  assert.equal(extractValue('regex:"type": "[A-Z]+"', sarcasm), '"type": "TEXT"', 'no group: the whole match');
  assert.deepEqual(extractRow({ title: 'field:title', type: 'field:type', author: 'first_of:author.name|author.username', media_url: 'field:mediaUrl' }, vault),
    { title: 'Prompt Vault Manager', type: 'TEXT', author: 'dillonbowen123' }, 'a field with no value is left out');
});

test('wrong_extractor both ways, naming the extractors that apply; unknown names stay bad_extractor', () => {
  for (const spec of ['heading', 'first_code_block', 'first_image', 'image:2', 'link_after:Source', 'first_paragraph']) {
    assert.equal(code(() => extractValue(spec, sarcasm)), 'wrong_extractor', spec);
  }
  assert.throws(() => extractValue('heading', sarcasm), /JSON: use field:<path>, first_of:<path>\|<path>, const:<value>, regex:<pattern>/);
  const md = entriesOf({ ...parseMarkdown('# T\n\n## A\n\ntext\n', 'https://x.example/a.md'), id: 'd' } as unknown as StoredDoc, 2);
  assert.equal(md.length, 1);
  assert.equal(code(() => extractValue('field:title', md[0])), 'wrong_extractor');
  assert.equal(code(() => extractValue('first_of:a|b', md[0])), 'wrong_extractor');
  assert.throws(() => extractValue('field:title', md[0]), /markdown.*heading, heading_raw, first_code_block/);
  assert.equal(extractValue('const:x', md[0]), 'x', 'const and regex are shared');
  assert.equal(code(() => extractValue('bogus:1', sarcasm)), 'bad_extractor');
  assert.throws(() => extractValue('bogus:1', sarcasm), /field:<path>/);
});

test('bad paths are bad_extractor', () => {
  assert.equal(code(() => extractValue('field:', sarcasm)), 'bad_extractor');
  assert.equal(code(() => extractValue('field:a..b', sarcasm)), 'bad_extractor');
  assert.equal(code(() => extractValue('field:a[', sarcasm)), 'bad_extractor');
  assert.equal(code(() => extractValue('field:a[x]', sarcasm)), 'bad_extractor');
  assert.deepEqual(parsePath('tags[].tag.name', 'x'), [{ key: 'tags' }, 'all', { key: 'tag' }, { key: 'name' }]);
  assert.deepEqual(parsePath('a[0][1]', 'x'), [{ key: 'a' }, { at: 0 }, { at: 1 }]);
});

test('where keeps records whose value equals one of the values, strings without case', () => {
  const titles = (f: Parameters<typeof filterEntries>[1]) => filterEntries(entries, f).kept.map((e) => e.heading);
  assert.equal(filterEntries(entries, { where: { type: ['TEXT', 'IMAGE'] } }).kept.length, 5);
  assert.deepEqual(titles({ where: { type: 'video' } }), ['Company Introduction'], 'a single value, any case');
  assert.equal(filterEntries(entries, { where: { type: ['text'] } }).dropped, 7);
  assert.deepEqual(titles({ where: { 'category.slug': 'writing' } }), ['Sarcasm'], 'a nested path');
  assert.deepEqual(titles({ where: { 'tags[].tag.name': 'sre' } }), ['Disk Capacity Runway Forecaster'], 'any item of an array');
  assert.deepEqual(titles({ where: { type: 'TEXT', 'category.slug': 'coding' } }), ['Linux Terminal'], 'every path must match');
  assert.equal(filterEntries(entries, { where: { voteCount: 9 } }).kept.length, 1, 'a number');
  assert.equal(filterEntries(entries, { where: { isFeatured: false } }).kept.length, 10, 'a boolean');
  assert.equal(filterEntries(entries, { where: { mediaUrl: null } }).kept.length, 8, 'null matches a path with nothing');
  assert.equal(filterEntries(entries, { where: { type: ['NOPE'] } }).kept.length, 0);
});

test('has keeps records whose paths all hold a value; not_containing looks in the record\'s JSON', () => {
  assert.deepEqual(filterEntries(entries, { has: ['mediaUrl'] }).kept.map((e) => e.heading.slice(0, 8)), ['Photorea', 'Japanese']);
  assert.equal(filterEntries(entries, { has: ['mediaUrl', 'category.name'] }).kept.length, 2);
  assert.equal(filterEntries(entries, { has: ['tags[].tag.name'] }).kept.length, 8, 'an empty array is nothing (two records have no tags)');
  assert.equal(filterEntries(entries, { has: ['category'] }).kept.length, 9, 'null is nothing');
  assert.deepEqual(filterEntries(entries, { not_containing: 'maki-e' }).kept.length, 9);
  assert.equal(filterEntries(entries, { where: { type: 'IMAGE' }, has: ['mediaUrl'], not_containing: 'puffin' }).kept.length, 1, 'filters combine');
});

test('the heading filters do not apply to JSON, and where / has do not apply to markdown', () => {
  assert.equal(code(() => filterEntries(entries, { heading_matches: 'a' })), 'wrong_filter');
  assert.equal(code(() => filterEntries(entries, { has_image: true })), 'wrong_filter');
  assert.throws(() => filterEntries(entries, { has_code_block: true }), /where, has or not_containing/);
  const md = entriesOf({ ...parseMarkdown('# T\n\n## A\n\ntext\n', 'https://x.example/a.md'), id: 'd' } as unknown as StoredDoc, 2);
  assert.equal(code(() => filterEntries(md, { where: { a: 1 } })), 'wrong_filter');
  assert.equal(code(() => filterEntries(md, { has: ['a'] })), 'wrong_filter');
  assert.equal(filterEntries(md, { heading_matches: 'a' }).kept.length, 1);
  assert.equal(code(() => filterEntries(entries, { where: { 'a[': 1 } })), 'bad_extractor');
});
