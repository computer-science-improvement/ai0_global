/**
 * Spec 071 T3 against a throwaway Postgres with every migration applied: the owner's rounds view (done / waiting / open /
 * next per resource, the same numbers the SQL roll uses) and the manual restart (round + 1 under the roll's advisory lock).
 * Creates its own database next to EDITOR_PG_TEST_URL and drops it. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ContentLedger } from './content-ledger';
import { queryDataset } from './data-query';
import { restartRound, roundStates } from './data-rounds-api';
import { DataStore, DataStoreError } from './data-store';
import type { DataSchema, ReusePolicy } from './data.types';
import { createMigratedDb, type FreshDb } from '../editor/sysadmin/testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const R1 = 'telegram:@pgt071a_a';
const R2 = 'instagram:pgt071a-b';
const TODAY = { month: 3, day: 9 };

let db: FreshDb;
let pool: Pool;
let store: DataStore;
let ledger: ContentLedger;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'r071a');
  pool = db.pool;
  store = new DataStore(pool);
  ledger = new ContentLedger(pool);
});
after(async () => { await db?.drop(); });

let seq = 0;
/** A dataset of `n` rows numbered n..1 (import order is the reverse of `num`); returns the schema and the ids in import order. */
async function mk(policy: ReusePolicy, n: number) {
  const key = `pgt071a_${++seq}`;
  await store.createSchema({
    key, title: key, description: 'rounds api test', entity: 'item',
    fields: [{ name: 'num', type: 'int', description: 'Number' }, { name: 'label', type: 'text', description: 'Label' }],
    roles: { title: 'label' }, dedup_key: [], language: 'uk', default_license: 'own', reuse_policy: policy,
    suitable_for: 'tests', contains_personal_data: false, status: 'active',
  } as any, 'pgtest');
  const rows = Array.from({ length: n }, (_, i) => ({ num: n - i, label: `row ${i}` }));
  const res = await store.upsert(key, rows as any);
  assert.equal(res.inserted, n, JSON.stringify(res));
  const { rows: ids } = await pool.query(`SELECT d.id::text AS id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 ORDER BY d.id`, [key]);
  return { key, ids: ids.map((r) => r.id as string), schema: (await store.getSchema(key)) as DataSchema };
}
const ref = (key: string, id: string) => `data://${key}/${id}`;
const publish = (key: string, id: string, resource = R1) => ledger.record(ref(key, id), { resourceRef: resource, origin: 'editor', status: 'published' });
const SEQ: ReusePolicy = { kind: 'cycle', order: 'sequential', order_by: ['num'] };
const stateOn = async (schema: DataSchema, resource: string) => {
  const fresh = (await store.getSchema(schema.key)) as DataSchema;
  return (await roundStates(pool, fresh)).resources.find((r) => r.resource_ref === resource);
};

test('a dataset that does not repeat has no rounds', { skip }, async () => {
  const never = await mk({ kind: 'never' }, 2);
  await assert.rejects(() => roundStates(pool, never.schema), (e: any) => e instanceof DataStoreError && e.code === 'invalid');
  await assert.rejects(() => restartRound(pool, never.schema, R1), (e: any) => e instanceof DataStoreError && e.code === 'invalid');
});

test('rounds view: nothing posted yet lists no resource; then done / open / next per resource, passed counts as done', { skip }, async () => {
  const { schema, key, ids } = await mk(SEQ, 4);
  const empty = await roundStates(pool, schema);
  assert.deepEqual(empty, { key, order: 'sequential', order_by: ['num'], resources: [] });

  // num is n..1 in import order, so by `num` the last imported row comes first.
  await publish(key, ids[3]);
  await ledger.pass(ref(key, ids[2]), { resourceRef: R2 });
  const r1 = await stateOn(schema, R1);
  assert.deepEqual(r1, { resource_ref: R1, round: 1, started_at: null, total: 4, done: 1, waiting: 0, open: 3, next: ref(key, ids[2]) });
  const r2 = await stateOn(schema, R2);
  assert.equal(r2?.done, 1, 'a row put aside for the round is done on its resource');
  assert.equal(r2?.next, ref(key, ids[3]), 'the other resource is at its own place in the order');
  assert.deepEqual((await roundStates(pool, schema)).resources.map((r) => r.resource_ref), [R2, R1].sort());
});

test('rounds view: a random dataset has no next; a row held for approval is waiting, not open', { skip }, async () => {
  const rnd = await mk({ kind: 'cycle', order: 'random' }, 3);
  await publish(rnd.key, rnd.ids[0]);
  const s = await stateOn(rnd.schema, R1);
  assert.equal(s?.next, null);
  assert.equal((await roundStates(pool, rnd.schema)).order, 'random');
  assert.deepEqual((await roundStates(pool, rnd.schema)).order_by, []);
  assert.equal(s?.open, 2);

  const { schema, key, ids } = await mk(SEQ, 3);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@pgt071a_a', 'approve') ON CONFLICT DO NOTHING`);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ('@pgt071a_a', CURRENT_DATE) RETURNING id`)).rows[0].id;
  await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec)
     VALUES ($1, '@pgt071a_a', now() + interval '2 hours', 'text', 'x', 'awaiting_approval', $2)`, [plan, JSON.stringify({ library_ref: ref(key, ids[2]) })]);
  await publish(key, ids[0]);
  const w = await stateOn(schema, R1);
  assert.deepEqual([w?.total, w?.done, w?.waiting, w?.open], [3, 1, 1, 1]);
  assert.equal(w?.next, ref(key, ids[1]), 'the held row (first by num) is skipped');
});

test('rounds view: when the last row is posted the round rolls — round 2 with a start, nothing done in it', { skip }, async () => {
  const { schema, key, ids } = await mk(SEQ, 2);
  await publish(key, ids[0]);
  await publish(key, ids[1]);
  const s = await stateOn(schema, R1);
  assert.equal(s?.round, 2);
  assert.ok(s?.started_at, 'round 2 has a start');
  assert.deepEqual([s?.total, s?.done, s?.open], [2, 0, 2]);
  assert.equal(s?.next, ref(key, ids[1]));
  await publish(key, ids[1]);
  assert.equal((await stateOn(schema, R1))?.done, 1, 'a repeat in round 2 counts');
});

test('rounds view: the round start is compared in SQL at full precision — a post a fraction of a millisecond before it is not counted in the round (R6)', { skip }, async () => {
  const { schema, key, ids } = await mk(SEQ, 3);
  await publish(key, ids[0]);
  // The post lands at T + 100 µs and round 2 starts at T + 600 µs: a JS Date holds milliseconds only, so a start passed as a
  // parameter would read as T and count the earlier post as done in the new round.
  const T = '2026-10-20 10:00:00.000+00';
  await pool.query(`UPDATE content_ledger SET used_at = $3::timestamptz + interval '100 microseconds' WHERE source_ref = $1 AND resource_ref = $2`, [ref(key, ids[0]), R1, T]);
  await pool.query(
    `INSERT INTO data_reuse_rounds AS r (schema_id, resource_ref, round, started_at) VALUES ($1, $2, 2, $3::timestamptz + interval '600 microseconds')
     ON CONFLICT (schema_id, resource_ref) DO UPDATE SET round = 2, started_at = EXCLUDED.started_at`, [schema.id, R1, T]);
  const s = await stateOn(schema, R1);
  assert.equal(s?.round, 2);
  assert.deepEqual([s?.total, s?.done, s?.open], [3, 0, 3], 'the earlier post is round 1\'s');
  assert.equal(s?.next, ref(key, ids[2]));
  // And one just after the start does count.
  await pool.query(`UPDATE content_ledger SET used_at = $3::timestamptz + interval '700 microseconds' WHERE source_ref = $1 AND resource_ref = $2`, [ref(key, ids[0]), R1, T]);
  assert.equal((await stateOn(schema, R1))?.done, 1);
});

test('restart: starts the next round at once; round-1 posts no longer count; a second restart is round 3', { skip }, async () => {
  const { schema, key, ids } = await mk(SEQ, 3);
  await publish(key, ids[2]);
  await publish(key, ids[1], R2);
  const before = await stateOn(schema, R1);
  assert.equal(before?.round, 1);
  assert.equal(before?.done, 1);

  const after1 = await restartRound(pool, schema, R1);
  assert.equal(after1.round, 2);
  assert.ok(after1.started_at);
  assert.deepEqual([after1.total, after1.done, after1.open], [3, 0, 3]);
  assert.equal(after1.next, ref(key, ids[2]), 'back to the start of the order');
  assert.equal((await stateOn(schema, R2))?.round, 1, 'the other resource is untouched');

  // The agents' read agrees: every row is unposted on R1 again, and on R2 one is still done.
  const fresh = (await store.getSchema(key)) as DataSchema;
  const on = async (res: string) => (await queryDataset(pool, fresh, { audience: 'owner', limit: 20, today: TODAY, unpostedOn: res, fields: ['num'] })).rows.length;
  assert.equal(await on(R1), 3);
  assert.equal(await on(R2), 2);

  await publish(key, ids[2]);
  assert.equal((await stateOn(schema, R1))?.done, 1);
  const after2 = await restartRound(pool, (await store.getSchema(key)) as DataSchema, R1);
  assert.equal(after2.round, 3);
  assert.equal(after2.done, 0);
});

test('restart: a channel key is normalised; an unknown or scope-wide resource is refused and leaves no row', { skip }, async () => {
  const { schema, key, ids } = await mk(SEQ, 2);
  await publish(key, ids[0]);
  const viaKey = await restartRound(pool, schema, '@pgt071a_a');
  assert.equal(viaKey.resource_ref, R1);
  assert.equal(viaKey.round, 2);

  await assert.rejects(() => restartRound(pool, schema, 'telegram:@never_posted'), (e: any) => e instanceof DataStoreError && e.code === 'not_found');
  await assert.rejects(() => restartRound(pool, schema, '*'), (e: any) => e instanceof DataStoreError && e.code === 'invalid');
  await assert.rejects(() => restartRound(pool, schema, 'telegram:*'), (e: any) => e instanceof DataStoreError && e.code === 'invalid');
  const { rows } = await pool.query(`SELECT resource_ref FROM data_reuse_rounds WHERE schema_id = $1`, [schema.id]);
  assert.deepEqual(rows.map((r) => r.resource_ref), [R1], 'no junk round rows');
});

test('restart is serialised with the roll: two at once are round 2 and round 3, never a lost update', { skip }, async () => {
  const { schema, key, ids } = await mk(SEQ, 3);
  await publish(key, ids[0]);
  const [a, b] = await Promise.all([restartRound(pool, schema, R1), restartRound(pool, schema, R1)]);
  assert.deepEqual([a.round, b.round].sort(), [2, 3]);
  const { rows } = await pool.query(`SELECT round FROM data_reuse_rounds WHERE schema_id = $1 AND resource_ref = $2`, [schema.id, R1]);
  assert.equal(rows[0].round, 3);
});
