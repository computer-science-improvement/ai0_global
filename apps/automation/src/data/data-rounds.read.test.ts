// Spec 071 T2, the read side with fake pools: the round order of queryDataset, nextInRound and its lazy roll, the catalog
// (reuse text, `repeat`, the roll on zero), the summary line and the null runway. The SQL itself runs in
// data-rounds.read.pg.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, catalogEntry, reuseText, summarize } from './data-catalog';
import { nextInRound, queryDataset, type QueryOptions } from './data-query';
import { isCycleRef, orderWord, recentTailSql, repeatOf, roundOrderSql, RECENT_TAIL_DAYS } from './data-rounds';
import type { DataSchema, FieldDef, ReusePolicy } from './data.types';
import { BOOKS } from './testing/books-schema';
import { catalogOverview, catalogPromptSummary, checkLowRunway } from '../editor/tools/catalog-context';

const SEQ: ReusePolicy = { kind: 'cycle', order: 'sequential', order_by: ['pages', 'title'] };
const withPolicy = (p: ReusePolicy): DataSchema => ({ ...BOOKS, reuse_policy: p });
const base: QueryOptions = { audience: 'agent', limit: 5, today: { month: 3, day: 9 } };

function fakePool(answer: (sql: string, params: unknown[]) => any = () => ({ rows: [] })) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return answer(sql, params); } } as any };
}
const itemsQuery = (c: Array<{ sql: string; params: unknown[] }>) => c.filter((x) => /FROM data_items d WHERE/.test(x.sql));

test('roundOrderSql: order_by fields typed like the filter SQL, NULLS LAST, import order last; unknown or unorderable names are left out', () => {
  const fields: FieldDef[] = [
    { name: 'ticket', type: 'int', description: 't' }, { name: 'title', type: 'text', description: 't' }, { name: 'body', type: 'long_text', description: 'b' },
  ];
  const sql = roundOrderSql({ kind: 'cycle', order: 'sequential', order_by: ['ticket', 'title'] }, fields);
  assert.match(sql, /^\(CASE WHEN jsonb_typeof\(d\.data->'ticket'\) = 'number' THEN \(d\.data->>'ticket'\)::numeric END\) ASC NULLS LAST, NULLIF\(d\.data->>'title', ''\) ASC NULLS LAST, d\.id ASC$/);
  assert.equal(roundOrderSql({ kind: 'cycle', order: 'sequential' }, fields), 'd.id ASC', 'import order without order_by');
  assert.equal(roundOrderSql({ kind: 'cycle', order: 'sequential', order_by: ['body', 'gone', "x'; DROP"] }, fields), 'd.id ASC', 'long text, unknown and unsafe names never reach SQL');
});

test('queryDataset: a sequential cycle dataset read with unposted_on goes in round order (overriding order), flagged ordered', async () => {
  const { pool, calls } = fakePool();
  const r = await queryDataset(pool, withPolicy(SEQ), { ...base, unpostedOn: 'telegram:@pdr', order: 'newest', withTotal: true });
  const q = itemsQuery(calls)[0];
  assert.match(q.sql, /ORDER BY \(CASE WHEN jsonb_typeof\(d\.data->'pages'\) = 'number'.*NULLIF\(d\.data->>'title', ''\) ASC NULLS LAST, d\.id ASC LIMIT/s);
  assert.doesNotMatch(q.sql, /created_at DESC|random\(\)/, 'neither the requested newest nor random');
  assert.equal(r.ordered, true);
  // The count query drops ORDER BY, LIMIT and OFFSET: every placeholder it keeps is one it still uses.
  const count = calls.find((c) => /count\(\*\)::int AS n/.test(c.sql))!;
  const used = new Set([...count.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.deepEqual([...used].sort((a, b) => a - b), count.params.map((_, i) => i + 1), 'no unused parameter in the count query');
});

test('queryDataset: no round order without unposted_on, for a random cycle, or for never / after_days; random cycle puts last week\'s rows last', async () => {
  for (const [name, schema, o, want] of [
    ['sequential without unposted_on', withPolicy(SEQ), {}, /ORDER BY random\(\)/],
    ['never', withPolicy({ kind: 'never' }), { unpostedOn: '@c' }, /ORDER BY random\(\)/],
    ['after_days, newest', withPolicy({ kind: 'after_days', days: 30 }), { unpostedOn: '@c', order: 'newest' as const }, /ORDER BY d\.created_at DESC, d\.id DESC/],
  ] as const) {
    const { pool, calls } = fakePool();
    const r = await queryDataset(pool, schema, { ...base, ...o });
    assert.match(itemsQuery(calls)[0].sql, want, name);
    assert.equal(r.ordered, undefined, name);
  }
  const rnd = fakePool();
  const r = await queryDataset(rnd.pool, withPolicy({ kind: 'cycle', order: 'random' }), { ...base, unpostedOn: '@c', withTotal: true });
  const q = itemsQuery(rnd.calls)[0];
  assert.match(q.sql, new RegExp(`ORDER BY EXISTS \\(SELECT 1 FROM content_ledger lt WHERE lt\\.resource_ref = \\$\\d+ AND lt\\.status = 'published'\\s+AND lt\\.used_at > now\\(\\) - interval '${RECENT_TAIL_DAYS} days'.*\\) ASC, random\\(\\) LIMIT`, 's'));
  assert.equal(r.ordered, undefined, 'random rounds have no "next"');
  const keep = rnd.calls.find((c) => /count\(\*\)::int AS n/.test(c.sql))!;
  const used = new Set([...keep.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.deepEqual([...used].sort((a, b) => a - b), keep.params.map((_, i) => i + 1));
  // An explicit newest / oldest from the agent is kept on a random cycle dataset.
  const nw = fakePool();
  await queryDataset(nw.pool, withPolicy({ kind: 'cycle', order: 'random' }), { ...base, unpostedOn: '@c', order: 'oldest' });
  assert.match(itemsQuery(nw.calls)[0].sql, /ORDER BY d\.created_at ASC, d\.id ASC/);
  assert.match(recentTailSql('$1', '$2'), /'data:\/\/' \|\| \$2 \|\| '\/' \|\| d\.id::text, d\.legacy_ref/);
});

test('nextInRound: the first row of the round, scoped to a category; null for datasets that are not in order', async () => {
  const f = fakePool((sql) => (/FROM data_items d WHERE/.test(sql) ? { rows: [{ id: '7', data: { title: 'x' }, status: 'active' }] } : { rows: [] }));
  const seq = withPolicy(SEQ);
  const r = await nextInRound(f.pool, seq, 'telegram:@pdr', { month: 3, day: 9 }, 'Дорожні_знаки%');
  assert.deepEqual(r, { ref: 'data://books/7', rolled: false });
  const q = itemsQuery(f.calls)[0];
  assert.match(q.sql, /d\.category ILIKE/);
  assert.ok(q.params.includes('Дорожні\\_знаки\\%'), 'the category is matched literally (LIKE wildcards escaped)');
  assert.match(q.sql, /data_postable|LIMIT/);
  for (const p of [{ kind: 'never' }, { kind: 'cycle', order: 'random' }] as ReusePolicy[]) {
    const none = fakePool();
    assert.deepEqual(await nextInRound(none.pool, withPolicy(p), 'telegram:@pdr', { month: 1, day: 1 }), { ref: null, rolled: false });
    assert.equal(none.calls.length, 0, 'no query for a dataset that is not in order');
  }
});

test('nextInRound: nothing left → the database rolls the round, then the row comes back; no roll → null', async () => {
  let rolled = false;
  const f = fakePool((sql) => {
    if (/data_round_roll/.test(sql)) { rolled = true; return { rows: [{ rolled: true }] }; }
    if (/FROM data_items d WHERE/.test(sql)) return { rows: rolled ? [{ id: '1', data: {}, status: 'active' }] : [] };
    return { rows: [] };
  });
  assert.deepEqual(await nextInRound(f.pool, withPolicy(SEQ), 'telegram:@pdr', { month: 1, day: 1 }), { ref: 'data://books/1', rolled: true });
  const g = fakePool((sql) => (/data_round_roll/.test(sql) ? { rows: [{ rolled: false }] } : { rows: [] }));
  assert.deepEqual(await nextInRound(g.pool, withPolicy(SEQ), 'telegram:@pdr', { month: 1, day: 1 }), { ref: null, rolled: false });
  assert.equal(g.calls.filter((c) => /data_round_roll/.test(c.sql)).length, 1);
  assert.deepEqual(g.calls.find((c) => /data_round_roll/.test(c.sql))!.params, [BOOKS.id, 'telegram:@pdr']);
});

test('reuseText: never, after_days, and both cycle orders (with the order-by fields)', () => {
  assert.equal(reuseText({ kind: 'never' }), 'post each row once per resource');
  assert.equal(reuseText({ kind: 'after_days', days: 90 }), 'may be posted again on the same resource after 90 days');
  assert.match(reuseText({ kind: 'cycle', order: 'random' }), /once per resource in every round, in random order; when every row has been posted there, a new round starts/);
  assert.match(reuseText({ kind: 'cycle', order: 'sequential' }), /in order \(import order\); when every row/);
  assert.match(reuseText(SEQ), /in order \(by pages, title, then import order\)/);
  assert.notEqual(reuseText({ kind: 'cycle', order: 'random' }), reuseText({ kind: 'cycle', order: 'sequential' }));
});

test('catalog entry and summary: a cycle dataset carries repeat {order, order_by, round}; others carry none', () => {
  const e = catalogEntry(withPolicy(SEQ), { rows: 10, unposted_here: 4, round: 2 });
  assert.deepEqual(e.repeat, { order: 'sequential', order_by: ['pages', 'title'], round: 2 });
  assert.equal(e.reuse, reuseText(SEQ));
  assert.deepEqual(summarize(e).repeat, e.repeat);
  const noRes = catalogEntry(withPolicy({ kind: 'cycle', order: 'random' }), { rows: 10 });
  assert.deepEqual(noRes.repeat, { order: 'random' }, 'no round without a resource');
  assert.equal(catalogEntry(BOOKS, { rows: 3, round: 5 }).repeat, undefined);
  assert.equal('repeat' in summarize(catalogEntry(BOOKS, { rows: 3 })), false);
  assert.deepEqual(repeatOf(withPolicy({ kind: 'cycle' } as any)), { order: 'random' }, 'a policy written by SQL without order is random');
  assert.equal(orderWord({ order: 'sequential' }), 'по черзі');
  assert.equal(orderWord({ order: 'random' }), 'випадково');
});

const schemaRow = (s: DataSchema) => ({ ...s, unposted_network: null, top_categories: [], fill_rate: {}, stats_at: null });

test('buildCatalog: a cycle dataset with postable rows and none left here rolls the round and counts again', async () => {
  const s = withPolicy({ kind: 'cycle', order: 'sequential' });
  let rolled = false;
  let counts = 0;
  const f = fakePool((sql) => {
    if (/FROM data_schemas s LEFT JOIN data_schema_stats/.test(sql)) return { rows: [schemaRow(s)] };
    if (/GROUP BY d\.schema_id/.test(sql)) { counts++; return { rows: [{ schema_id: s.id, rows: 10, today_items: 0, not_postable: 2, unposted_here: rolled ? 8 : 0 }] }; }
    if (/data_round_roll/.test(sql)) { rolled = true; return { rows: [{ rolled: true }] }; }
    if (/FROM data_reuse_rounds/.test(sql)) return { rows: [{ schema_id: s.id, round: 3, started_at: new Date() }] };
    return { rows: [] };
  });
  const [e] = await buildCatalog(f.pool, { dataset: 'books', resource: 'telegram:@pdr', today: { month: 1, day: 1 } });
  assert.equal(counts, 2, 'counted twice: before and after the roll');
  assert.equal(e.unposted_here, 8);
  assert.deepEqual(e.repeat, { order: 'sequential', round: 3 });
  assert.deepEqual(f.calls.find((c) => /data_round_roll/.test(c.sql))!.params, [s.id, 'telegram:@pdr']);
});

test('buildCatalog: no roll when rows are left, when every row is unpostable, without a resource, or for a dataset that is not a cycle', async () => {
  const s = withPolicy({ kind: 'cycle', order: 'random' });
  const run = async (schema: DataSchema, count: Record<string, unknown>, resource: string | null) => {
    const f = fakePool((sql) => {
      if (/FROM data_schemas s LEFT JOIN data_schema_stats/.test(sql)) return { rows: [schemaRow(schema)] };
      if (/GROUP BY d\.schema_id/.test(sql)) return { rows: [{ schema_id: schema.id, rows: 10, today_items: 0, not_postable: 0, unposted_here: 0, ...count }] };
      return { rows: [] };
    });
    const [e] = await buildCatalog(f.pool, { resource, today: { month: 1, day: 1 } });
    return { e, rolls: f.calls.filter((c) => /data_round_roll/.test(c.sql)).length, rounds: f.calls.filter((c) => /data_reuse_rounds/.test(c.sql)).length };
  };
  assert.equal((await run(s, { unposted_here: 3 }, '@pdr')).rolls, 0, 'rows left');
  assert.equal((await run(s, { rows: 4, not_postable: 4 }, '@pdr')).rolls, 0, 'every row unpostable: a round never loops on them');
  const noRes = await run(s, {}, null);
  assert.equal(noRes.rolls, 0);
  assert.equal(noRes.rounds, 0, 'no round lookup without a resource');
  assert.deepEqual(noRes.e.repeat, { order: 'random' });
  const never = await run(BOOKS, { unposted_here: 0 }, '@pdr');
  assert.deepEqual([never.rolls, never.rounds, never.e.repeat], [0, 0, undefined], 'a never / after_days dataset never touches the round tables');
});

const row = (dataset: string, extra: Record<string, unknown> = {}) => ({
  dataset, title: dataset, entity: 'item', description: 'd', suitable_for: 's', language: 'uk', fields: ['a'], rows: 866, unposted_network: null, top_categories: [], ...extra,
}) as any;

test('catalogPromptSummary: a cycle dataset is shown by its round, a stock dataset keeps the old line', () => {
  const text = catalogPromptSummary({
    datasets: [
      row('pdr_questions', { title: 'ПДР', unposted_here: 840, repeat: { order: 'sequential', round: 2 }, runway_days: null }),
      row('quotes', { title: 'Цитати', unposted_here: 30, rows: 100, not_postable: 5, runway_days: 12.5, today_items: 2 }),
      row('pdr_random', { title: 'Тест', unposted_here: 10, rows: 20, repeat: { order: 'random' } }),
    ],
    apis: [], feeds: [],
  });
  assert.match(text, /• pdr_questions: ПДР — по колу \(по черзі\), коло 2: лишилось 840 з 866/);
  assert.match(text, /• pdr_random: Тест — по колу \(випадково\): лишилось 10 з 20/, 'no round number without one');
  assert.match(text, /• quotes: Цитати — невикористаних тут 30 з 95 \(ще 5 без даних для поста\), сьогодні 2, запас 12.5 дн\./);
  assert.doesNotMatch(text.split('\n').find((l) => l.startsWith('• pdr_questions'))!, /запас/, 'a round has no runway');
});

test('catalogOverview: runway_days is null for a cycle dataset (the stock does not run out); checkLowRunway skips it', async () => {
  const s = withPolicy({ kind: 'cycle', order: 'sequential' });
  const answer = (sql: string) => {
    if (/FROM data_schemas s LEFT JOIN data_schema_stats/.test(sql)) return { rows: [schemaRow(s)] };
    if (/GROUP BY d\.schema_id/.test(sql)) return { rows: [{ schema_id: s.id, rows: 10, today_items: 0, not_postable: 0, unposted_here: 2 }] };
    if (/FROM data_reuse_rounds/.test(sql)) return { rows: [] };
    if (/FROM content_ledger WHERE resource_ref/.test(sql)) return { rows: [{ key: 'books', used28: 56, last: new Date('2026-10-20T00:00:00Z') }] };
    if (/FROM playbooks/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const f = fakePool(answer);
  const o = await catalogOverview(f.pool, { resource: 'telegram:@pdr', today: { month: 1, day: 1 } });
  assert.equal(o.datasets[0].runway_days, null);
  assert.deepEqual(o.datasets[0].repeat, { order: 'sequential', round: 1 });
  assert.equal(o.datasets[0].last_used_here, '2026-10-20T00:00:00.000Z');

  // The same usage on a stock dataset is a runway: 2 rows at 2 a day.
  const stock = fakePool((sql) => (/FROM data_schemas s LEFT JOIN data_schema_stats/.test(sql) ? { rows: [schemaRow(BOOKS)] } : answer(sql)));
  const so = await catalogOverview(stock.pool, { resource: 'telegram:@pdr', today: { month: 1, day: 1 } });
  assert.equal(so.datasets[0].runway_days, 1);

  const pb = { body: { series: [{ name: 'q', resource_ref: 'telegram:@pdr', format: 'text', cadence: 'daily 10:00', brief: 'b', source: { kind: 'library', table: 'books' }, active: true }] } };
  const posted: unknown[] = [];
  const low = await checkLowRunway({ pool: f.pool, inbox: { post: async (i: unknown) => { posted.push(i); } } as any }, { id: 'a', handle: 'pdr' }, pb.body);
  assert.deepEqual([low, posted], [[], []], 'no low_runway card for a dataset that repeats in rounds');
  // Control: the same series on a stock dataset (1 day of material) does raise the card.
  const ctrl = await checkLowRunway({ pool: stock.pool, inbox: { post: async (i: unknown) => { posted.push(i); } } as any }, { id: 'a', handle: 'pdr' }, pb.body);
  assert.deepEqual([ctrl, posted.length], [['books'], 1]);
});

test('isCycleRef: a data:// or library:// ref of a cycle dataset; anything else, or an error, is false', async () => {
  const pool = (kind: string | null) => fakePool((sql) => {
    if (/FROM data_items d JOIN data_schemas s/.test(sql)) return { rows: kind ? [{ key: 'books', id: '1', legacy_ref: null }] : [] };
    if (/SELECT reuse_policy->>'kind'/.test(sql)) return { rows: [{ kind }] };
    return { rows: [] };
  }).pool;
  assert.equal(await isCycleRef(pool('cycle'), 'data://books/1'), true);
  assert.equal(await isCycleRef(pool('never'), 'data://books/1'), false);
  assert.equal(await isCycleRef(pool(null), 'data://books/9'), false, 'a row that is gone');
  assert.equal(await isCycleRef(pool('cycle'), 'https://example.org/x'), false, 'a URL is no content ref');
  assert.equal(await isCycleRef(pool('cycle'), null), false);
  assert.equal(await isCycleRef({ query: async () => { throw new Error('down'); } } as any, 'data://books/1'), false);
});
