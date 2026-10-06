import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDelimiter, parseCsv, type CsvRecord } from './csv-parser';

async function parse(input: string | Uint8Array | Array<string | Uint8Array>, opts = {}): Promise<CsvRecord[]> {
  const out: CsvRecord[] = [];
  for await (const r of parseCsv(Array.isArray(input) ? input : [input], opts)) out.push(r);
  return out;
}
const fields = (rs: CsvRecord[]) => rs.map((r) => r.fields);

test('plain comma CSV with LF and CRLF line ends', async () => {
  assert.deepEqual(fields(await parse('a,b\n1,2\n3,4\n')), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(fields(await parse('a,b\r\n1,2\r\n')), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(fields(await parse('a,b\r1,2')), [['a', 'b'], ['1', '2']], 'old Mac CR and no final newline');
});

test('a UTF-8 BOM is dropped, as bytes or as text', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('назва,ціна\nборщ,10\n')]);
  assert.deepEqual(fields(await parse(bytes)), [['назва', 'ціна'], ['борщ', '10']]);
  assert.deepEqual(fields(await parse('﻿a\n1\n')), [['a'], ['1']]);
});

test('quoted fields: delimiters, escaped quotes and newlines inside quotes; line numbers follow', async () => {
  const csv = 'id,text\n1,"a, b"\n2,"say ""hi"""\n3,"line1\nline2\r\nline3"\n4,end\n';
  const rs = await parse(csv);
  assert.deepEqual(fields(rs), [['id', 'text'], ['1', 'a, b'], ['2', 'say "hi"'], ['3', 'line1\nline2\r\nline3'], ['4', 'end']]);
  assert.deepEqual(rs.map((r) => r.line), [1, 2, 3, 4, 7]);
  assert.ok(rs.every((r) => !r.error));
});

test('empty fields, empty quoted fields and trailing delimiters', async () => {
  assert.deepEqual(fields(await parse('a,b,c\n,,\n"",x,\n')), [['a', 'b', 'c'], ['', '', ''], ['', 'x', '']]);
});

test('blank lines are skipped', async () => {
  assert.deepEqual(fields(await parse('a\n\n1\n\n\n2\n')), [['a'], ['1'], ['2']]);
});

test('delimiter detection: semicolon and tab, quotes ignored, comma on ties', async () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(detectDelimiter('"a;b;c",d,e\n'), ',', 'delimiters inside quotes do not count');
  assert.equal(detectDelimiter('single'), ',');
  let used = '';
  const rs = await parse('назва;ціна;опис\nборщ;"10,5";"смачний; гарячий"\n', { onDelimiter: (d: string) => { used = d; } });
  assert.equal(used, ';');
  assert.deepEqual(fields(rs)[1], ['борщ', '10,5', 'смачний; гарячий']);
  assert.deepEqual(fields(await parse('a\tb\n1\t"x\ty"\n')), [['a', 'b'], ['1', 'x\ty']]);
});

test('an explicit delimiter wins over detection', async () => {
  assert.deepEqual(fields(await parse('a;b,c\n1;2,3\n', { delimiter: ',' })), [['a;b', 'c'], ['1;2', '3']]);
});

test('chunk boundaries anywhere (inside quotes, CRLF, multi-byte characters) give the same result', async () => {
  const csv = 'id,назва\r\n1,"Київ, ""центр""\r\nрайон"\r\n2,Львів\r\n';
  const whole = await parse(csv);
  const bytes = Buffer.from(csv);
  for (let size = 1; size <= 7; size++) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
    assert.deepEqual(await parse(parts), whole, `chunk size ${size}`);
  }
  assert.deepEqual(fields(whole)[1], ['1', 'Київ, "центр"\r\nрайон']);
});

test('a character after a closing quote marks only that row broken', async () => {
  const rs = await parse('a,b\n"x"y,1\n2,3\n');
  assert.match(rs[1].error!, /after a closing quote/);
  assert.deepEqual(rs[1].fields, ['xy', '1']);
  assert.equal(rs[2].error, undefined);
  assert.deepEqual(rs[2].fields, ['2', '3']);
});

test('an unclosed quote at the end of the file is reported and the rows after it are recovered', async () => {
  const rs = await parse('a,b\n1,"broken\n2,ok\n3,fine\n');
  assert.equal(rs[1].line, 2);
  assert.equal(rs[1].error, 'unterminated quoted field');
  assert.deepEqual(rs.slice(2).map((r) => [r.line, r.fields, r.error]), [[3, ['2', 'ok'], undefined], [4, ['3', 'fine'], undefined]]);
});

test('an unbalanced quote that pairs with a later quote breaks one row, not the rows it swallowed', async () => {
  const rs = await parse('a,b\n1,"broken\n2,ok\n3,"fine"\n4,last\n');
  assert.equal(rs[1].line, 2);
  assert.match(rs[1].error!, /closing quote/);
  assert.deepEqual(rs.slice(2).map((r) => [r.line, r.fields, r.error]), [
    [3, ['2', 'ok'], undefined], [4, ['3', 'fine'], undefined], [5, ['4', 'last'], undefined],
  ]);
});

test('stray quotes inside an unquoted field are kept literally', async () => {
  assert.deepEqual(fields(await parse('a\n5" screen\n')), [['a'], ['5" screen']]);
});

test('a long header line beyond the first chunk still detects the delimiter', async () => {
  const header = Array.from({ length: 50 }, (_, i) => `column_${i}`).join(';');
  const rs = await parse([header.slice(0, 100), header.slice(100), '\n1;2\n']);
  assert.equal(rs[0].fields.length, 50);
  assert.deepEqual(rs[1].fields, ['1', '2']);
});
