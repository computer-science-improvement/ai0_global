// Spec 071: the rounds policy on the TypeScript side — the zod schema, the order_by checks of the store, the schema
// preview, and the ledger client's pass(). The SQL rules run in data-rounds.pg.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentLedger } from './content-ledger';
import { DataStore, DataStoreError } from './data-store';
import { reuseOrderByIssue, reusePolicySchema, schemaInputSchema, schemaPatchSchema, type FieldDef } from './data.types';
import { diffSchemas } from './schema-versioning';

const FIELDS: FieldDef[] = [
  { name: 'ticket_number', type: 'int', description: 'Ticket' },
  { name: 'question_num', type: 'int', description: 'Question' },
  { name: 'title', type: 'text', description: 'Title' },
  { name: 'kind', type: 'enum', description: 'Kind', enum: ['a', 'b'] },
  { name: 'body', type: 'long_text', description: 'Body' },
  { name: 'flag', type: 'bool', description: 'Flag' },
  { name: 'tags', type: 'text_list', description: 'Tags' },
];

test('reusePolicySchema: cycle defaults to random, takes up to three order_by names, refuses the rest', () => {
  assert.deepEqual(reusePolicySchema.parse({ kind: 'cycle' }), { kind: 'cycle', order: 'random' });
  assert.deepEqual(reusePolicySchema.parse({ kind: 'cycle', order: 'sequential', order_by: ['ticket_number', 'question_num'] }),
    { kind: 'cycle', order: 'sequential', order_by: ['ticket_number', 'question_num'] });
  assert.deepEqual(reusePolicySchema.parse({ kind: 'never' }), { kind: 'never' });
  assert.deepEqual(reusePolicySchema.parse({ kind: 'after_days', days: 120 }), { kind: 'after_days', days: 120 });
  for (const bad of [{ kind: 'cycle', order: 'shuffle' }, { kind: 'cycle', order_by: [] }, { kind: 'cycle', order_by: ['a', 'b', 'c', 'd'] },
    { kind: 'cycle', order_by: ['Bad Name'] }, { kind: 'cycle', order_by: ['a', 'a'] }, { kind: 'cycle', order_by: 'a' }, { kind: 'once' }]) {
    assert.equal(reusePolicySchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('reuseOrderByIssue: every name must be an existing scalar field', () => {
  assert.equal(reuseOrderByIssue({ kind: 'cycle', order_by: ['ticket_number', 'question_num', 'title'] }, FIELDS), null);
  assert.equal(reuseOrderByIssue({ kind: 'cycle', order_by: ['kind'] }, FIELDS), null, 'enum');
  assert.equal(reuseOrderByIssue({ kind: 'cycle' }, FIELDS), null, 'import order');
  assert.equal(reuseOrderByIssue({ kind: 'never' }, FIELDS), null);
  assert.equal(reuseOrderByIssue(undefined, FIELDS), null);
  assert.match(reuseOrderByIssue({ kind: 'cycle', order_by: ['nope'] }, FIELDS)!, /unknown field nope/);
  for (const f of ['body', 'flag', 'tags']) assert.match(reuseOrderByIssue({ kind: 'cycle', order_by: [f] }, FIELDS)!, /number, date, text or enum/, f);
});

const input = (reuse: unknown) => ({
  key: 'pdr_x', title: 'T', fields: FIELDS, roles: {}, dedup_key: [], reuse_policy: reuse,
});

test('schemaInputSchema checks order_by against the dataset fields', () => {
  assert.equal(schemaInputSchema.safeParse(input({ kind: 'cycle', order: 'sequential', order_by: ['ticket_number'] })).success, true);
  const bad = schemaInputSchema.safeParse(input({ kind: 'cycle', order: 'sequential', order_by: ['ghost'] }));
  assert.equal(bad.success, false);
  assert.match(JSON.stringify((bad as any).error.issues), /unknown field ghost/);
  assert.equal(schemaInputSchema.safeParse(input({ kind: 'cycle', order_by: ['body'] })).success, false, 'long text is not orderable');
});

test('schemaPatchSchema accepts a cycle policy', () => {
  assert.deepEqual(schemaPatchSchema.parse({ reuse_policy: { kind: 'cycle', order: 'sequential' } }).reuse_policy, { kind: 'cycle', order: 'sequential' });
});

test('DataStore.updateSchema refuses an order_by that is not a scalar field of the stored dataset, before any write', async () => {
  const writes: string[] = [];
  const prev = { id: 'sid', key: 'pdr_x', version: 1, fields: FIELDS, roles: {}, dedup_key: [], reuse_policy: { kind: 'never' }, post_requires: [] };
  const pool = {
    query: async (sql: string) => {
      if (/^UPDATE/i.test(sql)) writes.push(sql);
      if (/FROM data_schemas WHERE key/.test(sql)) return { rows: [prev] };
      if (/count\(\*\)::int AS rows/.test(sql)) return { rows: [{ rows: 3 }] };
      return { rows: [] };
    },
  } as any;
  const store = new DataStore(pool);
  await assert.rejects(store.updateSchema('pdr_x', { reuse_policy: { kind: 'cycle', order: 'sequential', order_by: ['ghost'] } }, { changedBy: 't' }),
    (e: unknown) => e instanceof DataStoreError && e.code === 'invalid' && /unknown field ghost/.test(e.message));
  await assert.rejects(store.updateSchema('pdr_x', { reuse_policy: { kind: 'cycle', order: 'sequential', order_by: ['flag'] } }, { changedBy: 't' }), /number, date, text or enum/);
  assert.deepEqual(writes, []);
});

test('the preview shows a reuse-only edit as a change that keeps the version; an unchanged policy in another key order is no change', () => {
  const prev = { version: 3, fields: FIELDS, roles: {}, dedup_key: [], reuse_policy: { kind: 'after_days', days: 120 } } as any;
  const same = diffSchemas(prev, { ...prev, reuse_policy: { days: 120, kind: 'after_days' } });
  assert.deepEqual(same.changes, [], 'jsonb reorders keys');
  const cycle = diffSchemas(prev, { ...prev, reuse_policy: { kind: 'cycle', order: 'sequential' } });
  assert.deepEqual(cycle.changes, [{ kind: 'dataset_text', field: 'reuse_policy' }]);
  assert.equal(cycle.structural, false);
  assert.equal(cycle.nextVersion, 3);
  const pr = diffSchemas({ ...prev, post_requires: [] }, { ...prev, post_requires: [['title']] });
  assert.deepEqual(pr.changes, [{ kind: 'dataset_text', field: 'post_requires' }]);
  const order = diffSchemas({ ...prev, reuse_policy: { kind: 'cycle', order: 'random' } }, { ...prev, reuse_policy: { order: 'sequential', kind: 'cycle' } });
  assert.equal(order.changes.length, 1);
});

function fakePool(answer: (sql: string, params: unknown[]) => any = () => ({ rows: [] })) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return answer(sql, params); } } as any };
}

test('ContentLedger.pass: calls content_ledger_pass with the resource ref; blanks never query; true only when recorded', async () => {
  const f = fakePool(() => ({ rows: [{ passed: true }] }));
  const l = new ContentLedger(f.pool);
  assert.equal(await l.pass('', { resourceRef: '@c' }), false);
  assert.equal(await l.pass('data://pdr/1', { resourceRef: '  ' }), false);
  assert.equal(f.calls.length, 0);
  assert.equal(await l.pass('data://pdr/1', { resourceRef: '@c', origin: 'editor', slotId: 'not-a-uuid', note: 'critic: no source' }), true);
  assert.match(f.calls[0].sql, /content_ledger_pass/);
  assert.deepEqual(f.calls[0].params, ['telegram:@c', 'data://pdr/1', 'editor', null, 'critic: no source']);
  const none = new ContentLedger(fakePool(() => ({ rows: [{ passed: false }] })).pool);
  assert.equal(await none.pass('data://pdr/1', { resourceRef: '@c' }), false, 'a non-cycle dataset records nothing');
});

test('ContentLedger.pass is best-effort: an error (a database without migration 096) is logged, never thrown', async () => {
  const logs: string[] = [];
  const l = new ContentLedger({ query: async () => { throw new Error('function content_ledger_pass does not exist'); } } as any, (m) => logs.push(m));
  assert.equal(await l.pass('data://pdr/1', { resourceRef: 'telegram:@c' }), false);
  assert.match(logs[0], /not passed: function content_ledger_pass does not exist/);
});
