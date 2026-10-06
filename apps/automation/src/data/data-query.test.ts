import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataQueryError, queryDataset, type QueryOptions } from './data-query';
import { BOOKS } from './testing/books-schema';

function fakePool(rows: any[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: sql.includes('count(*)::int AS n') ? [{ n: rows.length }] : rows }; } } as any };
}

const base: QueryOptions = { audience: 'agent', limit: 5, today: { month: 3, day: 9 } };

async function refused(o: Partial<QueryOptions>, code: string, re: RegExp) {
  const { pool, calls } = fakePool();
  await assert.rejects(queryDataset(pool, BOOKS, { ...base, ...o }), (e: any) => e instanceof DataQueryError && e.code === code && re.test(e.message));
  assert.equal(calls.length, 0, 'nothing reaches the database');
}

test('agents: a field that is not agent_visible (or deprecated, or unknown) is refused', async () => {
  await refused({ fields: ['title', 'isbn'] }, 'field_not_visible', /"isbn" of "books" is not visible/);
  await refused({ fields: ['old_note'] }, 'field_not_visible', /deprecated/);
  await refused({ fields: ['nope'] }, 'unknown_field', /no field "nope"/);
});

test('filters only on filterable fields, with an operator that fits the type', async () => {
  await refused({ filters: [{ field: 'title', op: 'eq', value: 'x' }] }, 'field_not_filterable', /"title" of "books" is not filterable; filterable: isbn, genre, pages, tags, birthday, raw/);
  await refused({ filters: [{ field: 'pages', op: 'ilike', value: '3' }] }, 'invalid_op', /ilike works on text fields/);
  await refused({ filters: [{ field: 'genre', op: 'gte', value: 'a' }] }, 'invalid_op', /number and date fields/);
  await refused({ filters: [{ field: 'genre', op: 'eq', value: 'drama' }] }, 'invalid_value', /allowed: novel, poetry/);
  await refused({ filters: [{ field: 'pages', op: 'eq', value: '3.5' }] }, 'invalid_value', /an integer/);
  await refused({ filters: [{ field: 'pages', op: 'between', value: [1] }] }, 'invalid_value', /\[from, to\]/);
  await refused({ filters: [{ field: 'genre', op: 'in', value: [] }] }, 'invalid_value', /1–50 values/);
  await refused({ filters: [{ field: 'raw', op: 'eq', value: 1 }] }, 'invalid_value', /only is_null/);
  await refused({ filters: [{ field: 'pages', op: 'today' }] }, 'invalid_op', /today works on date/);
});

test('owner may filter on a filterable field agents cannot see; agents may too (visibility is about returned fields)', async () => {
  const { pool, calls } = fakePool();
  await queryDataset(pool, BOOKS, { ...base, audience: 'owner', filters: [{ field: 'isbn', op: 'eq', value: '1' }] });
  assert.match(calls[0].sql, /d\.data @> \$\d+::jsonb/);
  assert.ok(calls[0].params.includes('{"isbn":"1"}'));
});

test('SQL: eq on a list, in, ilike escaping, range casts, is_null, today through the month_day role, unposted_on', async () => {
  const { pool, calls } = fakePool();
  await queryDataset(pool, BOOKS, {
    ...base, order: 'newest', unpostedOn: 'telegram:@books',
    filters: [
      { field: 'tags', op: 'eq', value: 'classic' },
      { field: 'genre', op: 'in', value: ['novel', 'poetry'] },
      { field: 'isbn', op: 'ilike', value: '50%_off' },
      { field: 'pages', op: 'between', value: [100, '300'] },
      { field: 'raw', op: 'is_null', value: false },
      { field: 'birthday', op: 'today' },
    ],
  });
  const { sql, params } = calls[0];
  assert.ok(params.includes('{"tags":["classic"]}'));
  assert.deepEqual(params.find((p) => Array.isArray(p)), ['"novel"', '"poetry"']);
  assert.ok(params.includes('%50\\%\\_off%'));
  assert.match(sql, /BETWEEN \$\d+::numeric AND \$\d+::numeric/);
  assert.match(sql, /NOT \(d\.data->'raw' IS NULL/);
  assert.match(sql, /d\.event_month = \$\d+ AND d\.event_day = \$\d+/);
  assert.match(sql, /^WITH used AS/);
  assert.match(sql, /content_ledger_used\(\$\d+\)/, 'used rows come from the content ledger (023 FR-010)');
  assert.doesNotMatch(sql, /d\.posted \?/, 'the legacy posted markers are no longer read directly');
  assert.ok(params.includes('telegram:@books'));
  assert.match(sql, /ORDER BY d\.created_at DESC/);
});

test('agent rows: only the requested fields plus a data:// ref; long text cut to 2000 unless full', async () => {
  const long = 'я'.repeat(2500);
  const row = { id: '42', data: { title: 'Кобзар', summary: long, isbn: 'secret', genre: 'poetry' } };
  const r = await queryDataset(fakePool([row]).pool, BOOKS, { ...base, fields: ['title', 'summary'] });
  assert.deepEqual(Object.keys(r.rows[0]), ['ref', 'title', 'summary']);
  assert.equal(r.rows[0].ref, 'data://books/42');
  assert.equal((r.rows[0].summary as string).length, 2001);
  assert.deepEqual(r.truncated, ['summary']);
  const full = await queryDataset(fakePool([row]).pool, BOOKS, { ...base, fields: ['summary'], full: true });
  assert.equal((full.rows[0].summary as string).length, 2500);
  const all = await queryDataset(fakePool([row]).pool, BOOKS, base);
  assert.ok(!('isbn' in all.rows[0]) && !('old_note' in all.rows[0]), 'default projection = visible, non-deprecated fields');
});

test('agents get at most 20 rows; the owner listing counts the total', async () => {
  const { pool, calls } = fakePool([{ id: '1', data: {} }]);
  await queryDataset(pool, BOOKS, { ...base, limit: 500 });
  assert.equal(calls[0].params.at(-2), 20);
  const owner = fakePool([{ id: '1', data: {}, body: 'x'.repeat(400) }]);
  const r = await queryDataset(owner.pool, BOOKS, { ...base, audience: 'owner', limit: 25, offset: 50, withTotal: true, search: 'кобзар' });
  assert.equal(r.total, 1);
  assert.equal(owner.calls[1].params.length, owner.calls[0].params.length - 2, 'count reuses the filter params');
  assert.match(owner.calls[0].sql, /plainto_tsquery\('simple'/);
  assert.match(owner.calls[0].sql, /d\.data->>'title' ILIKE/, 'searchable fields are searched too');
  assert.equal((r.rows[0].body as string).length, 301);
});
