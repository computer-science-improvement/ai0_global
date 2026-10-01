import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsertSql } from './loader.js';

const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('buildInsertSql: default is ON CONFLICT DO NOTHING with numbered placeholders', () => {
  const sql = norm(buildInsertSql('t', ['a', 'b'], '(a)', 2));
  assert.equal(sql, 'INSERT INTO t ("a", "b") VALUES ($1, $2), ($3, $4) ON CONFLICT (a) DO NOTHING');
});

test('buildInsertSql: updateColumns turns it into an upsert of only those columns', () => {
  const sql = norm(buildInsertSql('t', ['a', 'b', 'c'], '(a)', 1, ['b']));
  assert.equal(sql, 'INSERT INTO t ("a", "b", "c") VALUES ($1, $2, $3) ON CONFLICT (a) DO UPDATE SET "b" = EXCLUDED."b"');
});

test('buildInsertSql: an empty updateColumns list stays DO NOTHING', () => {
  const sql = norm(buildInsertSql('t', ['a'], '(a)', 1, []));
  assert.match(sql, /DO NOTHING$/);
});
