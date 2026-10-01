import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySql, wrapWithLimit } from './readonly-sql';

const ok = (q: string) => assert.equal(classifySql(q).ok, true, q);
const no = (q: string, re?: RegExp) => {
  const v = classifySql(q);
  assert.equal(v.ok, false, q);
  if (re) assert.match((v as any).reason, re);
};

test('accepts SELECT and WITH, trailing semicolon', () => {
  ok('SELECT 1');
  ok('select title, views from editor_v_post_performance where channel_id = \'x\' order by views desc;');
  ok('WITH t AS (SELECT 1 AS a) SELECT a FROM t');
  ok('(SELECT 1) UNION (SELECT 2)');
});

test('keywords inside string literals and comments do not trip the scan', () => {
  ok("SELECT 'please delete; drop table' AS s");
  ok('SELECT 1 -- delete everything\n');
});

test('rejects writes and DDL', () => {
  no('DELETE FROM recipes', /SELECT/);
  no('UPDATE recipes SET title = 1');
  no('INSERT INTO x VALUES (1)');
  no('DROP TABLE recipes');
  no('WITH d AS (DELETE FROM recipes RETURNING *) SELECT * FROM d', /DELETE/);
  no('SELECT * INTO newtable FROM recipes', /INTO/);
  no('TRUNCATE recipes');
});

test('rejects chains, COPY, SET ROLE, dangerous funcs, dollar quotes', () => {
  no('SELECT 1; DROP TABLE x', /single statement/);
  no('COPY recipes TO STDOUT');
  no('SET ROLE postgres');
  no('SELECT 1; SET ROLE postgres');
  no('SELECT pg_sleep(10)', /function/);
  no("SELECT pg_read_file('/etc/passwd')", /function/);
  no('SELECT $$x$$');
  no('');
  no('x'.repeat(5000), /longer/);
});

test('wrapWithLimit clamps', () => {
  assert.equal(wrapWithLimit('SELECT 1', 50), 'SELECT * FROM (SELECT 1) AS _q LIMIT 50');
  assert.match(wrapWithLimit('SELECT 1', 10_000), /LIMIT 200$/);
  assert.match(wrapWithLimit('SELECT 1', 0), /LIMIT 1$/);
});
