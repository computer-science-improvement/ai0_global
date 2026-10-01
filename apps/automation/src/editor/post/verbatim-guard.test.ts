import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerbatim, longestCommonRun } from './verbatim-guard';
import { makeSpec } from './testing/fixtures';

const SRC = 'Протріть сир через сито, щоб маса стала однорідною і ніжною. Додайте яйця, цукор, ванільний цукор і дрібку солі, ретельно перемішайте ложкою.';
const pool = (src: string | null) => ({ query: async () => ({ rows: src === null ? [] : [{ src }] }) }) as any;
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
