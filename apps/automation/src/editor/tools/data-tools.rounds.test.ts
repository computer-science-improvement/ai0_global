// Spec 071 T2, the agent tools: query_data on a dataset that repeats in rounds (next + note, the roll on zero, the unpostable
// note), library_catalog (repeat, no runway) and the edit_data_schema `reuse` target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDataSchemaSuggestion, buildDataTools, EditSchemaInput, QueryDataInput } from './data-tools';
import { reuseText } from '../../data/data-catalog';
import { DataStore, DataStoreError } from '../../data/data-store';
import type { DataSchema, ReusePolicy } from '../../data/data.types';
import { BOOKS } from '../../data/testing/books-schema';
import type { ToolContext } from '../harness/tool';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@pdr' };
const seq = (p: Partial<ReusePolicy> = {}): DataSchema => ({ ...BOOKS, reuse_policy: { kind: 'cycle', order: 'sequential', ...p } as ReusePolicy });

function fakePool(o: { schema?: DataSchema; rounds?: (() => any[]); items?: () => any[]; roll?: () => boolean; counts?: any; pending?: any[]; anyTotal?: number } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const schema = o.schema ?? seq();
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM data_schemas WHERE key = \$1/.test(sql)) return { rows: [schema] };
      if (/data_round_roll/.test(sql)) return { rows: [{ rolled: o.roll ? o.roll() : false }] };
      if (/FROM data_reuse_rounds/.test(sql)) return { rows: o.rounds ? o.rounds() : [] };
      if (/count\(\*\)::int AS n, count\(\*\) FILTER/.test(sql)) return { rows: [o.counts ?? { n: 0, ok: 0 }] };
      // Spec 068's zero-hit note asks how many rows match with used ones included.
      if (/SELECT count\(\*\)::int AS n FROM data_items d WHERE/.test(sql)) return { rows: [{ n: o.anyTotal ?? 0 }] };
      if (/FROM pending_actions/.test(sql)) return { rows: o.pending ?? [] };
      if (/FROM data_items d WHERE/.test(sql)) return { rows: o.items ? o.items() : [] };
      return { rows: [] };
    },
  } as any;
  return { pool, calls };
}
const tools = (pool: any, actions?: any) => Object.fromEntries(buildDataTools({ pool, actions, today: () => ({ month: 3, day: 9 }) }).map((t) => [t.name, t]));
const q = (i: Record<string, unknown> = {}) => QueryDataInput.parse({ schema: 'books', fields: ['title'], ...i });
const item = (id: string) => ({ id, data: { title: `t${id}` } });

test('query_data on an in-order dataset: repeat {order, order_by, round}, next = the first row, and the note', async () => {
  const f = fakePool({ schema: seq({ order_by: ['pages'] }), items: () => [item('7'), item('8')], rounds: () => [{ schema_id: BOOKS.id, round: 3, started_at: new Date() }] });
  const r: any = await tools(f.pool).query_data.execute(q({ order: 'newest' }), ctx);
  assert.deepEqual(r.repeat, { order: 'sequential', order_by: ['pages'], round: 3 });
  assert.equal(r.next, 'data://books/7');
  assert.deepEqual(r.rows.map((x: any) => x.ref), ['data://books/7', 'data://books/8']);
  assert.match(r.note, /датасет іде по черзі — бери перший рядок/);
  assert.deepEqual(f.calls.filter((c) => /data_round_roll/.test(c.sql)), [], 'rows found: no roll');
});

test('query_data: no next without unposted_on (null) or on a random-round dataset; repeat shows either way', async () => {
  const noRes = fakePool({ items: () => [item('7')] });
  const a: any = await tools(noRes.pool).query_data.execute(q({ unposted_on: null }), ctx);
  assert.equal(a.next, undefined);
  assert.doesNotMatch(a.note ?? '', /по черзі/);
  assert.deepEqual(a.repeat, { order: 'sequential' }, 'no round when no resource is asked about');
  assert.equal(noRes.calls.filter((c) => /FROM data_reuse_rounds/.test(c.sql)).length, 0);

  const rnd = fakePool({ schema: seq({ order: 'random' }), items: () => [item('7')] });
  const b: any = await tools(rnd.pool).query_data.execute(q(), ctx);
  assert.deepEqual([b.next, b.repeat], [undefined, { order: 'random', round: 1 }]);
});

test('query_data on a dataset that is not a cycle: the old answer, no repeat / next, no round queries', async () => {
  const f = fakePool({ schema: BOOKS, items: () => [item('1')] });
  const r: any = await tools(f.pool).query_data.execute(q(), ctx);
  assert.deepEqual(Object.keys(r).sort(), ['dataset', 'rows']);
  assert.equal(f.calls.filter((c) => /data_round_roll|data_reuse_rounds/.test(c.sql)).length, 0);
});

test('query_data: nothing left on a cycle dataset → the database rolls the round and the same query runs again', async () => {
  let rolled = false;
  const f = fakePool({
    items: () => (rolled ? [item('1')] : []), roll: () => { rolled = true; return true; },
    rounds: () => [{ schema_id: BOOKS.id, round: rolled ? 2 : 1, started_at: new Date() }],
  });
  const r: any = await tools(f.pool).query_data.execute(q(), ctx);
  assert.deepEqual(r.rows.map((x: any) => x.ref), ['data://books/1']);
  assert.equal(r.repeat.round, 2);
  assert.match(r.note, /щойно почалось нове коло/);
  assert.match(r.note, /бери перший рядок/);
  assert.equal(f.calls.filter((c) => /FROM data_items d WHERE/.test(c.sql)).length, 2);
  assert.deepEqual(f.calls.find((c) => /data_round_roll/.test(c.sql))!.params, [BOOKS.id, 'telegram:@pdr']);
});

test('query_data: still nothing after the roll (the filters, or no round ended) → the round note; and when every row is unpostable, it says so', async () => {
  const f = fakePool({ items: () => [], roll: () => false, anyTotal: 5 });
  const r: any = await tools(f.pool).query_data.execute(q({ filters: [{ field: 'genre', op: 'eq', value: 'poetry' }] }), ctx);
  assert.deepEqual(r.rows, []);
  assert.match(r.note, /nothing left in this round here with these filters/);
  assert.doesNotMatch(r.note, /lacks what a post needs/, 'a dataset without post_requires has no such note');
  assert.equal(f.calls.filter((c) => /data_round_roll/.test(c.sql)).length, 1);

  const dead = fakePool({ schema: { ...seq(), post_requires: [['title']] }, items: () => [], counts: { n: 40, ok: 0 } });
  const d: any = await tools(dead.pool).query_data.execute(q(), ctx);
  assert.match(d.note, /every one of the 40 rows of this dataset lacks what a post needs \(post_requires\): pick another dataset/);
  // The same note for a stock dataset; none when a postable row exists (the filters are the reason).
  const stock = fakePool({ schema: { ...BOOKS, post_requires: [['title']] }, items: () => [], counts: { n: 12, ok: 0 } });
  assert.match(((await tools(stock.pool).query_data.execute(q(), ctx)) as any).note, /every one of the 12 rows/);
  const some = fakePool({ schema: { ...BOOKS, post_requires: [['title']] }, items: () => [], counts: { n: 12, ok: 3 } });
  assert.doesNotMatch(((await tools(some.pool).query_data.execute(q(), ctx)) as any).note, /lacks what a post needs/);
});

test('query_data without unposted_on never rolls a round', async () => {
  const f = fakePool({ items: () => [] });
  await tools(f.pool).query_data.execute(q({ unposted_on: null }), ctx);
  assert.equal(f.calls.filter((c) => /data_round_roll/.test(c.sql)).length, 0);
});

test('library_catalog (one dataset): repeat with the round, the reuse text, and runway_days null', async () => {
  const s = seq({ order_by: ['pages', 'title'] });
  const pool = {
    query: async (sql: string) => {
      if (/FROM data_schemas s LEFT JOIN data_schema_stats/.test(sql)) return { rows: [{ ...s, unposted_network: null, top_categories: [], fill_rate: {}, stats_at: null }] };
      if (/GROUP BY d\.schema_id/.test(sql)) return { rows: [{ schema_id: s.id, rows: 10, today_items: 0, not_postable: 0, unposted_here: 4 }] };
      if (/FROM data_reuse_rounds/.test(sql)) return { rows: [{ schema_id: s.id, round: 2, started_at: new Date() }] };
      if (/FROM content_ledger WHERE resource_ref/.test(sql)) return { rows: [{ key: 'books', used28: 56, last: null }] };
      return { rows: [] };
    },
  } as any;
  const r: any = await tools(pool).library_catalog.execute({ dataset: 'books' }, ctx);
  assert.deepEqual(r.dataset.repeat, { order: 'sequential', order_by: ['pages', 'title'], round: 2 });
  assert.equal(r.dataset.reuse, reuseText(s.reuse_policy));
  assert.equal(r.dataset.runway_days, null);
  assert.equal(r.dataset.unposted_here, 4);
});

const REUSE_EVIDENCE = 'Рядки зі збірника йдуть по номерах, а канал бере їх навмання — порядок білетів губиться.';
const reuseInput = (o: Record<string, unknown> = {}) => EditSchemaInput.parse({
  dataset: 'books', target: 'reuse', reuse: { kind: 'cycle', order: 'sequential', order_by: ['pages'] }, old_text: reuseText(BOOKS.reuse_policy), evidence: REUSE_EVIDENCE, ...o,
});

test('edit_data_schema input: reuse needs `reuse` and no new_text; every other target still needs new_text', () => {
  assert.equal(EditSchemaInput.safeParse({ dataset: 'books', target: 'reuse', old_text: 'x', evidence: REUSE_EVIDENCE }).success, false, 'reuse without a rule');
  assert.equal(EditSchemaInput.safeParse({ dataset: 'books', target: 'description', old_text: 'x', evidence: REUSE_EVIDENCE }).success, false, 'description without new_text');
  assert.equal(EditSchemaInput.safeParse({ dataset: 'books', target: 'description', old_text: 'x', new_text: 'новий опис', evidence: REUSE_EVIDENCE }).success, true);
  assert.equal(reuseInput().new_text, undefined);
  assert.equal(EditSchemaInput.safeParse({ dataset: 'books', target: 'reuse', reuse: { kind: 'cycle', order_by: [] }, old_text: 'x', evidence: REUSE_EVIDENCE }).success, false, 'bad rule shape');
});

test('edit_data_schema reuse: proposes a card whose new_text is written from `reuse`, once; stale text, no change and a bad order_by are refused', async () => {
  const proposed: any[] = [];
  const actions = { propose: async (a: any) => { proposed.push(a); return { id: 'pa1', ...a }; } };
  const f = fakePool({ schema: BOOKS });
  const t = tools(f.pool, actions);
  const ok: any = await t.edit_data_schema.execute(reuseInput(), ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const want = reuseText({ kind: 'cycle', order: 'sequential', order_by: ['pages'] });
  assert.equal(proposed[0].payload.new_text, want);
  assert.deepEqual(proposed[0].payload.reuse, { kind: 'cycle', order: 'sequential', order_by: ['pages'] });
  assert.match(proposed[0].summary, /^Edit books reuse rule: “may be posted again on the same resource after 365 days” → “post each row once per resource in every round, in order \(by pages/);
  const dedupe = f.calls.find((c) => /FROM pending_actions/.test(c.sql))!;
  assert.deepEqual(dedupe.params, ['books', 'reuse', ''], 'dedupe key: target reuse, field blank');

  assert.equal(((await t.edit_data_schema.execute(reuseInput({ old_text: 'something else' }), ctx)) as any).error, 'stale_text');
  assert.equal(((await t.edit_data_schema.execute(reuseInput({ reuse: { kind: 'after_days', days: 365 } }), ctx)) as any).error, 'no_change');
  const bad: any = await t.edit_data_schema.execute(reuseInput({ reuse: { kind: 'cycle', order: 'sequential', order_by: ['ghost'] } }), ctx);
  assert.equal(bad.error, 'invalid_reuse');
  assert.match(bad.details, /unknown field ghost/);
  assert.match(((await t.edit_data_schema.execute(reuseInput({ reuse: { kind: 'cycle', order: 'sequential', order_by: ['summary'] } }), ctx)) as any).details, /number, date, text or enum/);
  assert.equal(proposed.length, 1);

  const again = tools(fakePool({ schema: BOOKS, pending: [{ '?column?': 1 }] }).pool, actions);
  assert.equal(((await again.edit_data_schema.execute(reuseInput(), ctx)) as any).error, 'already_suggested');
});

test('applyDataSchemaSuggestion: a reuse suggestion swaps the policy only; stale text and a bad order_by are refused', async () => {
  const patches: any[] = [];
  let current: DataSchema = BOOKS;
  const store = {
    requireSchema: async () => current,
    updateSchema: async (_k: string, patch: any) => {
      patches.push(patch);
      return { schema: { ...current, version: current.version }, diff: { structural: false, changes: [{ kind: 'dataset_text', field: 'reuse_policy' }], nextVersion: current.version } };
    },
  } as unknown as DataStore;
  const payload = { ...reuseInput(), new_text: reuseText({ kind: 'cycle', order: 'sequential', order_by: ['pages'] }), field: null };
  const r = await applyDataSchemaSuggestion(store, payload as any);
  assert.deepEqual(r, { dataset: 'books', version: BOOKS.version });
  assert.deepEqual(patches, [{ reuse_policy: { kind: 'cycle', order: 'sequential', order_by: ['pages'] } }]);
  await assert.rejects(applyDataSchemaSuggestion(store, { ...payload, old_text: 'old' } as any), (e: unknown) => e instanceof DataStoreError && e.code === 'conflict');
  // A suggestion applied after the policy changed is stale (the owner switched it meanwhile).
  current = { ...BOOKS, reuse_policy: { kind: 'never' } };
  await assert.rejects(applyDataSchemaSuggestion(store, payload as any), /stale/);
  assert.equal(patches.length, 1);
});
