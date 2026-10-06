import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonArray, parseJsonl, type JsonRecord } from './json-stream';
import { chunks } from './source-reader';

async function all(gen: AsyncGenerator<JsonRecord>): Promise<JsonRecord[]> {
  const out: JsonRecord[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

test('JSON array: objects one by one, nested values, strings with brackets and escapes', async () => {
  const text = '﻿ [ {"a": 1, "b": [1, {"c": "]"}]}, {"t": "кома, \\"лапки\\" і }"} ,{"n": null} ] ';
  const rs = await all(parseJsonArray([text]));
  assert.deepEqual(rs, [
    { row: 1, value: { a: 1, b: [1, { c: ']' }] } },
    { row: 2, value: { t: 'кома, "лапки" і }' } },
    { row: 3, value: { n: null } },
  ]);
});

test('JSON array: byte chunks of any size give the same records', async () => {
  const buf = Buffer.from(JSON.stringify([{ name: 'Їжак', tags: ['a', 'b'] }, { name: 'Ґанок' }]));
  const whole = await all(parseJsonArray([buf]));
  for (const size of [1, 2, 3, 5, 13]) assert.deepEqual(await all(parseJsonArray(chunks(buf, size))), whole);
});

test('JSON array: a broken element is an error record; the others survive', async () => {
  const rs = await all(parseJsonArray(['[{"a":1}, {a: 2}, 5, {"b":3}]']));
  assert.deepEqual(rs.map((r) => [r.row, r.error ? 'error' : r.value]), [[1, { a: 1 }], [2, 'error'], [3, 'error'], [4, { b: 3 }]]);
  assert.match(rs[1].error!, /invalid JSON/);
  assert.equal(rs[2].error, 'row is not a JSON object');
});

test('JSON array: not an array, truncated file, trailing garbage', async () => {
  assert.deepEqual(await all(parseJsonArray(['{"a":1}'])), [{ row: 0, error: 'expected a JSON array of objects' }]);
  const cut = await all(parseJsonArray(['[{"a":1}, {"b":']));
  assert.deepEqual(cut[0], { row: 1, value: { a: 1 } });
  assert.match(cut[1].error!, /not closed/);
  const trail = await all(parseJsonArray(['[{"a":1}] x']));
  assert.match(trail[1].error!, /after the array/);
  assert.deepEqual(await all(parseJsonArray(['   '])), [{ row: 0, error: 'expected a JSON array of objects' }]);
  assert.deepEqual(await all(parseJsonArray(['[]'])), []);
});

test('JSONL: one object per line, CRLF, blank lines, broken lines, no final newline', async () => {
  const rs = await all(parseJsonl(['{"a":1}\r\n\n{"b":', '2}\nnot json\n[1]\n{"c":"Київ"}']));
  assert.deepEqual(rs.map((r) => [r.row, r.value ?? r.error?.slice(0, 12)]), [
    [1, { a: 1 }], [3, { b: 2 }], [4, 'invalid JSON'], [5, 'row is not a'], [6, { c: 'Київ' }],
  ]);
});
