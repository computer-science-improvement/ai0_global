import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDataSchemaSuggestion, buildDataTools, QueryDataInput } from './data-tools';
import { catalogEntry } from '../../data/data-catalog';
import { BOOKS } from '../../data/testing/books-schema';
import type { ToolContext } from '../harness/tool';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@books_chan' };

/** A pool that answers the schema lookup, the catalog queries and the items query. */
function fakePool(o: { schema?: any; items?: any[]; stats?: any; counts?: any[]; pending?: any[] } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM data_schemas WHERE key = \$1/.test(sql)) return { rows: o.schema === null ? [] : [o.schema ?? BOOKS] };
      if (/FROM data_schemas s LEFT JOIN data_schema_stats/.test(sql)) return { rows: [{ ...(o.schema ?? BOOKS), ...(o.stats ?? {}) }] };
      if (/GROUP BY d\.schema_id/.test(sql)) return { rows: o.counts ?? [] };
      if (/FROM pending_actions/.test(sql)) return { rows: o.pending ?? [] };
      if (/FROM data_items d WHERE/.test(sql)) return { rows: o.items ?? [] };
      return { rows: [] };
    },
  } as any;
  return { pool, calls };
}

function tools(pool: any, actions?: any) {
  return Object.fromEntries(buildDataTools({ pool, actions, today: () => ({ month: 3, day: 9 }) }).map((t) => [t.name, t]));
}
const q = (i: Record<string, unknown>) => QueryDataInput.parse({ schema: 'books', ...i });

test('query_data refuses a field that is not agent_visible and a filter on a field that is not filterable', async () => {
  const { pool, calls } = fakePool();
  const t = tools(pool);
  const hidden: any = await t.query_data.execute(q({ fields: ['title', 'isbn'] }), ctx);
  assert.equal(hidden.error, 'field_not_visible');
  assert.match(hidden.details, /"isbn" of "books" is not visible to agents/);
  const nf: any = await t.query_data.execute(q({ fields: ['title'], filters: [{ field: 'summary', op: 'ilike', value: 'x' }] }), ctx);
  assert.equal(nf.error, 'field_not_filterable');
  assert.match(nf.details, /filterable: isbn, genre, pages, tags, birthday, raw/);
  assert.ok(!calls.some((c) => /FROM data_items/.test(c.sql)), 'no row query ran');
});

test('query_data input: ≤ 20 rows, ≥ 1 field, known operators only', () => {
  assert.equal(QueryDataInput.safeParse({ schema: 'books', fields: ['title'], limit: 21 }).success, false);
  assert.equal(QueryDataInput.safeParse({ schema: 'books', fields: [] }).success, false);
  assert.equal(QueryDataInput.safeParse({ schema: 'books', fields: ['title'], filters: [{ field: 'genre', op: 'like', value: 'x' }] }).success, false);
  assert.equal(QueryDataInput.parse({ schema: 'books', fields: ['title'] }).limit, 5);
});

test('query_data returns only the asked fields with data:// refs and skips rows used on the current resource by default', async () => {
  const { pool, calls } = fakePool({ items: [{ id: '12', data: { title: 'Кобзар', summary: 'я'.repeat(2100), genre: 'poetry', isbn: 'x' } }] });
  const t = tools(pool);
  const r: any = await t.query_data.execute(q({ fields: ['title', 'summary'], filters: [{ field: 'genre', op: 'eq', value: 'poetry' }] }), ctx);
  assert.deepEqual(Object.keys(r.rows[0]), ['ref', 'title', 'summary']);
  assert.equal(r.rows[0].ref, 'data://books/12');
  assert.deepEqual(r.truncated, ['summary']);
  const items = calls.find((c) => /FROM data_items d WHERE/.test(c.sql))!;
  assert.match(items.sql, /^WITH used AS/);
  assert.ok(items.params.includes('telegram:@books_chan'), 'the ledger is keyed by the resource ref');

  const all = fakePool({ items: [] });
  await tools(all.pool).query_data.execute(q({ fields: ['title'], unposted_on: null }), ctx);
  assert.doesNotMatch(all.calls.find((c) => /FROM data_items d WHERE/.test(c.sql))!.sql, /used AS/, 'null = include used rows');

  const platform = fakePool({ items: [] });
  await tools(platform.pool).query_data.execute(q({ fields: ['title'] }), { ...ctx, channelKey: null, extras: { platformSlot: { resourceRef: 'instagram:42' } } });
  assert.ok(platform.calls.find((c) => /FROM data_items d WHERE/.test(c.sql))!.params.includes('instagram:42'));
});

test('query_data: unknown and inactive datasets', async () => {
  assert.equal(((await tools(fakePool({ schema: null }).pool).query_data.execute(q({ fields: ['title'] }), ctx)) as any).error, 'unknown_dataset');
  assert.equal(((await tools(fakePool({ schema: { ...BOOKS, status: 'draft' } }).pool).query_data.execute(q({ fields: ['title'] }), ctx)) as any).error, 'dataset_not_active');
});

test('catalog entry from a fixture: visible fields with descriptions, values, fill %, live and network numbers', () => {
  const e = catalogEntry(BOOKS, {
    rows: 120, unposted_network: 80, unposted_here: 30, today_items: 2, stats_at: '2026-10-06T00:05:00.000Z',
    top_categories: [1, 2, 3, 4, 5, 6].map((n) => ({ category: `c${n}`, rows: 10 - n })),
    fill_rate: { title: 1, summary: 0.456, isbn: 1 },
  });
  assert.equal(e.dataset, 'books');
  assert.equal(e.description, 'Ukrainian classics for a reading channel');
  assert.equal(e.suitable_for, 'book clubs, literature channels');
  assert.equal(e.reuse, 'may be posted again on the same resource after 365 days');
  assert.deepEqual(e.fields.map((f) => f.name), ['title', 'summary', 'genre', 'pages', 'tags', 'birthday', 'raw'], 'no isbn (hidden), no old_note (deprecated)');
  assert.deepEqual(e.fields.find((f) => f.name === 'genre'), { name: 'genre', type: 'enum', description: 'Genre', filterable: true, values: ['novel', 'poetry'] });
  assert.equal(e.fields.find((f) => f.name === 'summary')!.fill_pct, 46);
  assert.equal(e.fields.find((f) => f.name === 'title')!.searchable, true);
  assert.equal(e.rows, 120);
  assert.equal(e.unposted_here, 30);
  assert.equal(e.unposted_network, 80);
  assert.equal(e.today_items, 2, 'books have a month_day role');
  assert.equal(e.top_categories.length, 5);
  assert.deepEqual(Object.keys(e.roles).sort(), ['category', 'month_day', 'body', 'title'].sort());
  const noDates = catalogEntry({ ...BOOKS, roles: { title: 'title' } }, { rows: 1 });
  assert.equal('today_items' in noDates, false);
});

test('library_catalog: one query for schemas+stats, one for live counts scoped to the resource', async () => {
  const { pool, calls } = fakePool({
    stats: { unposted_network: 7, top_categories: [{ category: 'poetry', rows: 3 }], fill_rate: { title: 1 }, stats_at: new Date('2026-10-06T00:05:00Z') },
    counts: [{ schema_id: BOOKS.id, rows: 9, today_items: 1, unposted_here: 4 }],
  });
  const r: any = await tools(pool).library_catalog.execute({}, ctx);
  assert.equal(r.datasets.length, 1);
  const d = r.datasets[0];
  assert.deepEqual(d, {
    dataset: 'books', title: 'Books', entity: 'book', description: 'Ukrainian classics for a reading channel', suitable_for: 'book clubs, literature channels',
    language: 'uk', fields: ['title', 'summary', 'genre', 'pages', 'tags', 'birthday', 'raw'], rows: 9, unposted_here: 4, unposted_network: 7,
    today_items: 1, top_categories: ['poetry'], last_used_here: null, runway_days: null,
  }, 'the overview: enough to choose, field names only (plus 023 last use and runway here)');
  assert.ok(Array.isArray(r.apis) && Array.isArray(r.feeds), 'spec 023: APIs and card feeds');
  assert.match(calls[0].sql, /WHERE s\.status = 'active'/);
  assert.deepEqual(calls[1].params.slice(1), [3, 9, 'telegram:@books_chan']);

  const full: any = await tools(pool).library_catalog.execute({ dataset: 'books' }, ctx);
  assert.equal(full.dataset.stats_at, '2026-10-06T00:05:00.000Z');
  assert.equal(full.dataset.fields.find((f: any) => f.name === 'title').fill_pct, 100);
  assert.equal(full.dataset.fields.find((f: any) => f.name === 'genre').description, 'Genre');
  assert.match(full.refs, /data:\/\/<dataset>\/<id>/);
});

test('edit_data_schema proposes a card only when the old text matches, once per text', async () => {
  const proposed: any[] = [];
  const actions = { propose: async (a: any) => { proposed.push(a); return { id: 'act-1', ...a }; } };
  const { pool } = fakePool();
  const t = tools(pool, actions);
  const base = { dataset: 'books', target: 'field', field: 'summary', old_text: 'Summary', new_text: 'Plot summary in Ukrainian, 2–5 sentences', evidence: 'Every row I read is a 2–5 sentence plot summary in Ukrainian.' };
  const stale: any = await t.edit_data_schema.execute({ ...base, old_text: 'Something else' }, ctx);
  assert.equal(stale.error, 'stale_text');
  const hidden: any = await t.edit_data_schema.execute({ ...base, field: 'isbn', old_text: 'ISBN' }, ctx);
  assert.equal(hidden.error, 'field_not_visible');
  const ok: any = await t.edit_data_schema.execute(base, { ...ctx, extras: { agent: { id: 'agent-9' }, chat: { chatId: null } } });
  assert.equal(ok.pending_action, 'act-1');
  assert.equal(proposed[0].kind, 'edit_data_schema');
  assert.equal(proposed[0].agentId, 'agent-9');
  assert.match(proposed[0].summary, /Edit books\.summary: “Summary” → “Plot summary/);
  const again: any = await tools(fakePool({ pending: [{ 1: 1 }] }).pool, actions).edit_data_schema.execute(base, ctx);
  assert.equal(again.error, 'already_suggested');
});

test('applying a suggestion is a description-only edit and refuses stale text', async () => {
  const updates: any[] = [];
  const store: any = {
    requireSchema: async () => BOOKS,
    updateSchema: async (key: string, patch: any, meta: any) => { updates.push({ key, patch, meta }); return { schema: { ...BOOKS, version: 3 }, diff: { structural: false } }; },
  };
  const p = { dataset: 'books', target: 'field', field: 'summary', old_text: 'Summary', new_text: 'Plot summary', evidence: 'rows are plot summaries in Ukrainian' };
  assert.deepEqual(await applyDataSchemaSuggestion(store, p), { dataset: 'books', version: 3 });
  assert.equal(updates[0].patch.fields.find((f: any) => f.name === 'summary').description, 'Plot summary');
  assert.equal(updates[0].patch.fields.length, BOOKS.fields.length);
  assert.match(updates[0].meta.reason, /^agent suggestion: rows are plot summaries/);
  await assert.rejects(applyDataSchemaSuggestion(store, { ...p, old_text: 'Old' }), /stale/);
  await applyDataSchemaSuggestion(store, { ...p, target: 'description', field: null, old_text: BOOKS.description, new_text: 'Better' });
  assert.deepEqual(updates[1].patch, { description: 'Better' });
});
