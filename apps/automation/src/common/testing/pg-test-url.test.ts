import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pgDbName, pgWithDb } from './pg-test-url';

test('a TCP URL: the database is read and swapped, the rest is kept', () => {
  const u = 'postgresql://u:p%40ss@localhost:5432/ai0_test?sslmode=disable';
  assert.equal(pgDbName(u), 'ai0_test');
  assert.equal(pgWithDb(u, 'ai0_test_m058_1'), 'postgresql://u:p%40ss@localhost:5432/ai0_test_m058_1?sslmode=disable');
});

test('a socket URL (user info, empty host) works where new URL() throws', () => {
  const u = 'postgresql://postgres@/db?host=/tmp/x&port=5432';
  assert.throws(() => new URL(u));
  assert.equal(pgDbName(u), 'db');
  assert.equal(pgWithDb(u, 'db_l026_7'), 'postgresql://postgres@/db_l026_7?host=/tmp/x&port=5432');
});

test('no database in the path → postgres; a database is added before the query', () => {
  assert.equal(pgDbName('postgres://localhost:5432'), 'postgres');
  assert.equal(pgDbName('postgres://localhost/?host=/tmp/x'), 'postgres');
  assert.equal(pgWithDb('postgres://localhost:5432', 'x'), 'postgres://localhost:5432/x');
  assert.equal(pgWithDb('postgres://postgres@?host=/tmp/x', 'x'), 'postgres://postgres@/x?host=/tmp/x');
});

test('not a URL → a clear error', () => {
  assert.throws(() => pgDbName('host=/tmp/x dbname=db'), /not a postgres connection URL/);
});
