import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceValue, compileRowSchema, validateRow } from './field-validation';
import type { FieldDef } from './data.types';

const f = (name: string, type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef => ({ name, type, description: '', ...extra });

function check(field: FieldDef, value: unknown) {
  const r = validateRow(compileRowSchema([field]), { [field.name]: value }, 0);
  return r.ok ? { ok: true as const, value: r.value[field.name] } : { ok: false as const, error: r.issues[0].error };
}

test('text and long_text: strings pass; numbers become strings; objects fail', () => {
  assert.deepEqual(check(f('t', 'text'), 'Привіт'), { ok: true, value: 'Привіт' });
  assert.deepEqual(check(f('t', 'text'), 12), { ok: true, value: '12' });
  assert.equal(check(f('t', 'text'), { a: 1 }).ok, false);
  assert.equal(check(f('t', 'text'), 'x'.repeat(10_001)).ok, false, 'text is capped; long_text is not');
  assert.equal(check(f('t', 'long_text'), 'x'.repeat(10_001)).ok, true);
});

test('int: integer strings coerce, fractions and junk fail', () => {
  assert.deepEqual(check(f('n', 'int'), '42'), { ok: true, value: 42 });
  assert.deepEqual(check(f('n', 'int'), ' -7 '), { ok: true, value: -7 });
  assert.deepEqual(check(f('n', 'int'), 3), { ok: true, value: 3 });
  assert.equal(check(f('n', 'int'), '1.5').ok, false);
  assert.equal(check(f('n', 'int'), 2.5).ok, false);
  assert.equal(check(f('n', 'int'), 'abc').ok, false);
});

test('number: dot or comma decimals and exponents', () => {
  assert.deepEqual(check(f('n', 'number'), '1.5'), { ok: true, value: 1.5 });
  assert.deepEqual(check(f('n', 'number'), '1,5'), { ok: true, value: 1.5 });
  assert.deepEqual(check(f('n', 'number'), '2e3'), { ok: true, value: 2000 });
  assert.equal(check(f('n', 'number'), '1.2.3').ok, false);
});

test('bool: true/false, yes/no, 1/0', () => {
  for (const v of ['true', 'YES', '1', 't', true, 1]) assert.deepEqual(check(f('b', 'bool'), v), { ok: true, value: true }, String(v));
  for (const v of ['false', 'no', '0', false, 0]) assert.deepEqual(check(f('b', 'bool'), v), { ok: true, value: false }, String(v));
  assert.equal(check(f('b', 'bool'), 'maybe').ok, false);
});

test('date: ISO and DD.MM.YYYY; impossible dates fail', () => {
  assert.deepEqual(check(f('d', 'date'), '2024-02-29'), { ok: true, value: '2024-02-29' });
  assert.deepEqual(check(f('d', 'date'), '5.3.2024'), { ok: true, value: '2024-03-05' });
  assert.equal(check(f('d', 'date'), '2023-02-29').ok, false);
  assert.equal(check(f('d', 'date'), '2024-13-01').ok, false);
});

test('datetime: needs a date part and must parse', () => {
  assert.equal(check(f('d', 'datetime'), '2026-10-06T12:00:00Z').ok, true);
  assert.equal(check(f('d', 'datetime'), '2026-10-06 12:00:00+03').ok, true);
  assert.equal(check(f('d', 'datetime'), '12:00').ok, false);
});

test('month_day: MM-DD, M-D and DD.MM normalise; 02-30 fails', () => {
  assert.deepEqual(check(f('m', 'month_day'), '03-05'), { ok: true, value: '03-05' });
  assert.deepEqual(check(f('m', 'month_day'), '3-5'), { ok: true, value: '03-05' });
  assert.deepEqual(check(f('m', 'month_day'), '24.08'), { ok: true, value: '08-24' });
  assert.equal(check(f('m', 'month_day'), '02-30').ok, false);
  assert.equal(check(f('m', 'month_day'), '13-01').ok, false);
});

test('url and image_url: http(s) only', () => {
  assert.equal(check(f('u', 'url'), 'https://example.com/a').ok, true);
  assert.equal(check(f('u', 'image_url'), 'http://x.ua/p.jpg').ok, true);
  assert.equal(check(f('u', 'url'), 'javascript:alert(1)').ok, false);
  assert.equal(check(f('u', 'url'), 'example.com').ok, false);
});

test('enum: only listed values', () => {
  const e = f('c', 'enum', { enum: ['soup', 'dessert'] });
  assert.deepEqual(check(e, 'soup'), { ok: true, value: 'soup' });
  assert.equal(check(e, 'salad').ok, false);
});

test('text_list: arrays, JSON text, or | ; , separated strings', () => {
  assert.deepEqual(check(f('l', 'text_list'), ['a', 1]), { ok: true, value: ['a', '1'] });
  assert.deepEqual(check(f('l', 'text_list'), '["x","y"]'), { ok: true, value: ['x', 'y'] });
  assert.deepEqual(check(f('l', 'text_list'), 'a | b|c'), { ok: true, value: ['a', 'b', 'c'] });
  assert.deepEqual(check(f('l', 'text_list'), 'a; b'), { ok: true, value: ['a', 'b'] });
  assert.deepEqual(check(f('l', 'text_list'), 'a, b'), { ok: true, value: ['a', 'b'] });
  assert.equal(check(f('l', 'text_list'), [{ a: 1 }]).ok, false);
});

test('json: object text is parsed, anything else kept', () => {
  assert.deepEqual(check(f('j', 'json'), '{"a":[1,2]}'), { ok: true, value: { a: [1, 2] } });
  assert.deepEqual(check(f('j', 'json'), [1, 2]), { ok: true, value: [1, 2] });
  assert.deepEqual(check(f('j', 'json'), 'plain'), { ok: true, value: 'plain' });
});

test('required: missing or empty fails with "required"; defaults fill gaps on insert', () => {
  const fields = [f('a', 'text', { required: true }), f('b', 'int', { required: true, default: 0 }), f('c', 'text')];
  const z = compileRowSchema(fields);
  const miss = validateRow(z, { c: 'x' }, 3);
  assert.equal(miss.ok, false);
  assert.deepEqual((miss as any).issues, [{ row: 3, field: 'a', error: 'required' }]);
  const empty = validateRow(z, { a: '  ' }, 0);
  assert.equal(empty.ok, false, 'an empty CSV cell is no value');
  const ok = validateRow(z, { a: 'x' }, 0);
  assert.deepEqual(ok, { ok: true, value: { a: 'x', b: 0 } });
});

test('deprecated required fields are no longer required', () => {
  const z = compileRowSchema([f('a', 'text', { required: true, deprecated: true }), f('b', 'text')]);
  assert.equal(validateRow(z, { b: 'x' }, 0).ok, true);
});

test('patch mode: only given fields are checked; null clears an optional field', () => {
  const fields = [f('a', 'text', { required: true }), f('b', 'text'), f('n', 'int')];
  const z = compileRowSchema(fields, { mode: 'patch' });
  assert.deepEqual(validateRow(z, { b: null }, 0), { ok: true, value: { b: null } });
  assert.deepEqual(validateRow(z, { n: '5' }, 0), { ok: true, value: { n: 5 } });
  assert.equal(validateRow(z, { a: null }, 0).ok, false, 'a required field cannot be cleared');
});

test('unknown fields are rejected; _extra and _external_key pass', () => {
  const z = compileRowSchema([f('a', 'text')]);
  const bad = validateRow(z, { a: 'x', zzz: 1 }, 0);
  assert.equal(bad.ok, false);
  assert.match((bad as any).issues[0].error, /unknown field: zzz/);
  assert.equal(validateRow(z, { a: 'x', _extra: { col: 'v' }, _external_key: 'k1' }, 0).ok, true);
});

test('emptyAsNull=false keeps empty strings in text fields (JSON imports)', () => {
  assert.equal(coerceValue('text', '', false), '');
  assert.equal(coerceValue('text', '', true), undefined);
  assert.equal(coerceValue('int', '', false), undefined);
});
