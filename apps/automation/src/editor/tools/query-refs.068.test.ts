// Spec 068 FR-008: query_data by ref — the dataset check, the ids and legacy refs reaching the query, the flags, found: false,
// the hint for a filter on `id`, and the zero-hit note that no longer says "nothing unposted" when nothing matches at all. Fake pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataTools, QueryDataInput } from './data-tools';
import { BOOKS } from '../../data/testing/books-schema';
import type { ToolContext } from '../harness/tool';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@books_chan' };
const SCHEMA = { ...BOOKS, post_requires: [['title'], ['summary', 'genre']] };

/** `items` answers the row query; `total` answers the count (the zero-hit check). */
function fakePool(o: { items?: any[]; total?: number } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM data_schemas WHERE key = \$1/.test(sql)) return { rows: [SCHEMA] };
      if (/SELECT count\(\*\)::int AS n FROM data_items/.test(sql)) return { rows: [{ n: o.total ?? 0 }] };
      if (/FROM data_items d WHERE/.test(sql)) return { rows: o.items ?? [] };
      return { rows: [] };
    },
  } as any;
  const rowQueries = () => calls.filter((c) => /SELECT d\.id::text AS id/.test(c.sql));
  return { pool, calls, rowQueries };
}
const tool = (pool: any) => buildDataTools({ pool, today: () => ({ month: 3, day: 9 }) }).find((t) => t.name === 'query_data')!;
const q = (i: Record<string, unknown>) => QueryDataInput.parse({ schema: 'books', fields: ['title'], ...i });

test('refs input: 1 to 20 refs, optional', () => {
  assert.equal(QueryDataInput.safeParse({ schema: 'books', fields: ['title'], refs: [] }).success, false);
  assert.equal(QueryDataInput.safeParse({ schema: 'books', fields: ['title'], refs: Array.from({ length: 21 }, (_, i) => `data://books/${i + 1}`) }).success, false);
  assert.equal(QueryDataInput.safeParse({ schema: 'books', fields: ['title'], refs: ['data://books/1'] }).success, true);
  assert.equal(QueryDataInput.parse({ schema: 'books', fields: ['title'] }).refs, undefined);
});

test('a data:// ref of another dataset is ref_dataset_mismatch; so is one mixed into a valid list; a non-ref is invalid_ref; no row query runs', async () => {
  const { pool, rowQueries } = fakePool();
  const t = tool(pool);
  const one: any = await t.execute(q({ refs: ['data://prompts/7'] }), ctx);
  assert.equal(one.error, 'ref_dataset_mismatch');
  assert.match(one.details, /data:\/\/prompts\/7 belongs to dataset "prompts", not "books"; one dataset per call: pass schema: "prompts"/);
  assert.equal(((await t.execute(q({ refs: ['data://books/1', 'data://prompts/7'] }), ctx)) as any).error, 'ref_dataset_mismatch');
  const bad: any = await t.execute(q({ refs: ['https://prompthero.com/x/y'] }), ctx);
  assert.equal(bad.error, 'invalid_ref');
  assert.equal(rowQueries().length, 0);
});

test('the query takes the ids and legacy refs and nothing else: no status, no postable filter, no filters, no unposted skip; the flags are columns', async () => {
  const { pool, rowQueries } = fakePool({ items: [] });
  await tool(pool).execute(q({ refs: ['data://books/12', 'library://books_old/abc-1', 'data://books/13'], filters: [{ field: 'genre', op: 'eq', value: 'poetry' }], search: 'x', unposted_on: null }), ctx);
  const c = rowQueries()[0];
  assert.match(c.sql, /d\.id = ANY\(\$\d+::bigint\[\]\) OR d\.legacy_ref = ANY\(\$\d+::text\[\]\)/);
  assert.doesNotMatch(c.sql, /d\.status =/);
  assert.doesNotMatch(c.sql, /WHERE d\.schema_id = \$1 AND data_postable/);
  assert.doesNotMatch(c.sql, /ILIKE|@>|search @@/, 'filters and search are not applied');
  assert.match(c.sql, /data_postable\(\$\d+::jsonb, d\.data\) AS postable, data_post_missing\(\$\d+::jsonb, d\.data\) AS missing/);
  assert.doesNotMatch(c.sql, /used_here|WITH used AS/, 'unposted_on null: no resource, no used_here');
  assert.ok(c.params.some((p) => Array.isArray(p) && p.join() === '12,13'), 'ids');
  assert.ok(c.params.some((p) => Array.isArray(p) && p.join() === 'library://books_old/abc-1'), 'legacy refs');
  assert.ok(c.params.includes(JSON.stringify(SCHEMA.post_requires)));

  const here = fakePool({ items: [] });
  await tool(here.pool).execute(q({ refs: ['data://books/12'] }), ctx);
  const h = here.rowQueries()[0];
  assert.match(h.sql, /^WITH used AS/);
  assert.match(h.sql, /AS used_here/);
  assert.ok(h.params.includes('telegram:@books_chan'), 'the resource you work on is the default');
  assert.doesNotMatch(h.sql, /NOT EXISTS \(SELECT 1 FROM used/, 'used rows are flagged, not dropped');
});

test('rows come back in the order asked with their flags; a ref with no row is found: false; an alias says what was asked', async () => {
  const { pool } = fakePool({
    items: [
      { id: '13', legacy_ref: null, status: 'active', data: { title: 'Б' }, postable: false, missing: ['summary or genre'], used_here: false },
      { id: '12', legacy_ref: 'library://books_old/abc-1', status: 'hidden', data: { title: 'А' }, postable: true, missing: [], used_here: true },
    ],
  });
  const r: any = await tool(pool).execute(q({ refs: ['library://books_old/abc-1', 'data://books/99', 'data://books/13'] }), ctx);
  assert.deepEqual(r.rows, [
    { ref: 'data://books/12', title: 'А', status: 'hidden', postable: true, missing: [], used_here: true, requested: 'library://books_old/abc-1' },
    { ref: 'data://books/99', found: false },
    { ref: 'data://books/13', title: 'Б', postable: false, missing: ['summary or genre'], used_here: false },
  ]);
  assert.match(r.note, /1 ref\(s\) have no row in "books" \(found: false\)/);
  assert.match(r.note, /1 row\(s\) have postable: false/);

  const none: any = await tool(fakePool({ items: [] }).pool).execute(q({ refs: ['data://books/1'] }), ctx);
  assert.deepEqual(none.rows, [{ ref: 'data://books/1', found: false }]);
});

test('field visibility still applies to a refs query', async () => {
  const { pool, rowQueries } = fakePool();
  const r: any = await tool(pool).execute(q({ fields: ['isbn'], refs: ['data://books/1'] }), ctx);
  assert.equal(r.error, 'field_not_visible');
  assert.equal(rowQueries().length, 0);
});

test('a filter on the dataset id field says how to take a row by ref', async () => {
  const { pool } = fakePool();
  const r: any = await tool(pool).execute(q({ filters: [{ field: 'id', op: 'eq', value: 'https://cdn.example/1.png' }] }), ctx);
  assert.equal(r.error, 'unknown_field');
  assert.match(r.details, /щоб взяти рядок за ref — refs: \["data:\/\/<dataset>\/<id>"\]/);
  const other: any = await tool(pool).execute(q({ filters: [{ field: 'summary', op: 'eq', value: 'x' }] }), ctx);
  assert.equal(other.error, 'field_not_filterable');
  assert.doesNotMatch(other.details, /refs:/, 'the hint is only for id');
});

test('zero hits: used rows say so; nothing matching at all says the field may be empty; no filters says no postable rows; no resource says only that', async () => {
  const used: any = await tool(fakePool({ items: [], total: 4 }).pool).execute(q({ filters: [{ field: 'genre', op: 'eq', value: 'poetry' }] }), ctx);
  assert.equal(used.note, 'nothing left that is unposted here with these filters; loosen the filters or pick another dataset');

  const empty: any = await tool(fakePool({ items: [], total: 0 }).pool).execute(q({ search: 'щось' }), ctx);
  assert.match(empty.note, /no rows match these filters or this search, used or not: a field you filter or search on may be empty in most rows \(see fill % in library_catalog/);

  const bare: any = await tool(fakePool({ items: [], total: 0 }).pool).execute(q({}), ctx);
  assert.match(bare.note, /the dataset has no rows that can be posted/);

  const noRes = fakePool({ items: [], total: 9 });
  const plain: any = await tool(noRes.pool).execute(q({ unposted_on: null }), ctx);
  assert.equal(plain.note, 'no rows match these filters');
  assert.equal(noRes.calls.filter((c) => /count\(\*\)/.test(c.sql)).length, 0, 'no second query without a resource');
});
