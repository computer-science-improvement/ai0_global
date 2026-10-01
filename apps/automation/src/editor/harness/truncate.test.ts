import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toToolContent, truncateJson, truncateString } from './truncate';

test('truncateString keeps short strings and marks cut ones', () => {
  assert.equal(truncateString('abc', 5), 'abc');
  assert.equal(truncateString('abcdef', 3), 'abc…[truncated 3 chars]');
});

test('truncateJson passes small values through', () => {
  const v = { a: 1 };
  assert.equal(truncateJson(v, 100), v);
});

test('truncateJson wraps oversized values', () => {
  const out = truncateJson({ s: 'x'.repeat(50) }, 20) as any;
  assert.equal(out.truncated, true);
  assert.match(out.preview, /truncated/);
});

test('truncateJson handles undefined and circular', () => {
  assert.equal(truncateJson(undefined), null);
  const c: any = {}; c.self = c;
  assert.ok((truncateJson(c) as any).unserializable);
});

test('toToolContent caps length', () => {
  assert.equal(toToolContent({ ok: true }), '{"ok":true}');
  assert.match(toToolContent('y'.repeat(100), 10), /truncated/);
});
