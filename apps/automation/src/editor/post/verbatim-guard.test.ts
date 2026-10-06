import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerbatim, longestCommonRun } from './verbatim-guard';
import { makeSpec } from './testing/fixtures';

const SRC = 'Протріть сир через сито, щоб маса стала однорідною і ніжною. Додайте яйця, цукор, ванільний цукор і дрібку солі, ретельно перемішайте ложкою.';
const pool = (src: string | null) => ({ query: async () => ({ rows: src === null ? [] : [{ key: 'recipes', data: { description: src } }] }) }) as any;
const spec = (text: string, ref = 'library://recipes/3f2b8c1e-9a4d-4e2b-8f7a-1c2d3e4f5a6b') =>
  makeSpec({ origin: 'library', source: undefined, library_ref: ref, body: [{ type: 'p', text }] });

test('longestCommonRun ignores case and whitespace', () => {
  assert.equal(longestCommonRun('Abc  DEF', 'xx abc def yy'), 7);
});

test('rejects long verbatim copies from retell sources', async () => {
  const r = await checkVerbatim(pool(SRC), spec(`Сирники: ${SRC}`));
  assert.equal(r?.error, 'too_verbatim');
});

test('accepts a retelling', async () => {
  assert.equal(await checkVerbatim(pool(SRC), spec('Сир перетріть до гладкості, вбийте яйця, підсолодіть і додайте ваніль — і добре вимішайте.')), null);
});

test('quotes / prompts / pdr are intentionally verbatim; missing rows pass', async () => {
  assert.equal(await checkVerbatim(pool(SRC), spec(SRC, 'library://quotes/abc')), null);
  assert.equal(await checkVerbatim(pool(null), spec(SRC)), null);
});

test('data:// refs and their legacy aliases read the same row from the data store', async () => {
  const calls: any[] = [];
  const p = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [{ key: 'recipes', data: { description: 'a', instructions: SRC } }] }; } } as any;
  assert.equal((await checkVerbatim(p, spec(`Сирники: ${SRC}`, 'data://recipes/77')))?.error, 'too_verbatim');
  assert.match(calls[0].sql, /FROM data_items d JOIN data_schemas s/);
  assert.deepEqual(calls[0].params, ['recipes', null, '77']);
  await checkVerbatim(p, spec('x', 'library://recipes/abc'));
  assert.deepEqual(calls[1].params, ['recipes', 'library://recipes/abc', null]);
  assert.equal(await checkVerbatim(p, spec(SRC, 'data://books/5')), null, 'datasets outside the retell list are not checked');
});
