/**
 * Spec 071 against a throwaway Postgres with every migration applied (migration 096): rounds per dataset and resource,
 * the roll when the last open row is posted, `passed` rows, the switch to cycle, network stats and concurrency. The
 * database is created next to EDITOR_PG_TEST_URL and dropped at the end; the shared one is never touched. Skipped
 * unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ContentLedger } from './content-ledger';
import { DataStore } from './data-store';
import type { ReusePolicy } from './data.types';
import { createMigratedDb, type FreshDb } from '../editor/sysadmin/testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const R1 = 'telegram:@pgt071_a';
const R2 = 'instagram:pgt071-b';
const CYCLE: ReusePolicy = { kind: 'cycle', order: 'sequential' };

let db: FreshDb;
let pool: Pool;
let store: DataStore;
let ledger: ContentLedger;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'r071');
  pool = db.pool;
  store = new DataStore(pool);
  ledger = new ContentLedger(pool);
});

after(async () => {
  if (!url) return;
  await db?.drop();
});

let seq = 0;
/** A dataset of `n` rows (n1…nN) with a `needs` field the post_requires rule can use; returns the key and the row ids in import order. */
async function mk(policy: ReusePolicy, n: number, opts: { postRequires?: string[][]; key?: string } = {}) {
  const key = opts.key ?? `pgt071_${++seq}`;
  await store.createSchema({
    key, title: key, description: 'rounds test', entity: 'item',
    fields: [
      { name: 'num', type: 'int', description: 'Number', required: true },
      { name: 'needs', type: 'text', description: 'Needed for posting' },
    ],
    roles: { title: 'num' }, dedup_key: ['num'], language: 'uk', default_license: 'own', reuse_policy: policy,
    suitable_for: 'tests', contains_personal_data: false, status: 'active', ...(opts.postRequires ? { post_requires: opts.postRequires } : {}),
  } as any, 'pgtest');
  const res = await store.upsert(key, Array.from({ length: n }, (_, i) => ({ num: i + 1, needs: 'x' })));
  assert.equal(res.inserted, n, JSON.stringify(res));
  return { key, ids: await idsOf(key) };
}

async function idsOf(key: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT d.id::text AS id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 ORDER BY d.id`, [key]);
  return rows.map((r) => r.id);
}
const ref = (key: string, id: string) => `data://${key}/${id}`;
const publish = (key: string, id: string, resource = R1, usedAt?: Date) =>
  ledger.record(ref(key, id), { resourceRef: resource, origin: 'editor', status: 'published', usedAt });
const blocked = async (resource: string): Promise<Set<string>> =>
  new Set((await pool.query(`SELECT ref FROM content_ledger_used($1)`, [resource])).rows.map((r) => r.ref));
/** The ids of the rows nothing stops on the resource right now (what query_data would offer). */
async function open(key: string, ids: string[], resource = R1): Promise<string[]> {
  const b = await blocked(resource);
  return ids.filter((id) => !b.has(ref(key, id)));
}
async function round(key: string, resource = R1): Promise<{ round: number; started_at: Date } | null> {
  const { rows } = await pool.query(
    `SELECT r.round, r.started_at FROM data_reuse_rounds r JOIN data_schemas s ON s.id = r.schema_id WHERE s.key = $1 AND r.resource_ref = $2`, [key, resource]);
  return rows[0] ?? null;
}
const schemaId = async (key: string) => (await pool.query(`SELECT id FROM data_schemas WHERE key = $1`, [key])).rows[0].id as string;
const roll = async (key: string, resource = R1) => (await pool.query(`SELECT data_round_roll($1, $2) AS r`, [await schemaId(key), resource])).rows[0].r as boolean;

test('the policy: cycle is accepted with and without order, a bad shape is refused by the database', { skip }, async () => {
  const { key } = await mk({ kind: 'cycle', order: 'random' }, 1);
  const set = (p: unknown) => pool.query(`UPDATE data_schemas SET reuse_policy = $2::jsonb WHERE key = $1`, [key, JSON.stringify(p)]);
  await set({ kind: 'cycle' });
  await set({ kind: 'cycle', order: 'sequential', order_by: ['num', 'needs'] });
  await set({ kind: 'after_days', days: 300 });
  await set({ kind: 'never' });
  for (const bad of [{ kind: 'cycle', order: 'shuffle' }, { kind: 'cycle', order_by: [] }, { kind: 'cycle', order_by: ['a', 'b', 'c', 'd'] },
    { kind: 'cycle', order_by: ['Bad Name'] }, { kind: 'cycle', order_by: 'num' }, { kind: 'once' }, { kind: 'after_days', days: 0 }, { kind: 'after_days', days: 'ten' }]) {
    await assert.rejects(set(bad), /data_schemas_reuse_policy_check/, JSON.stringify(bad));
  }
  const checks = (await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'data_schemas'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%reuse_policy%'`)).rows;
  assert.deepEqual(checks.map((c) => c.conname), ['data_schemas_reuse_policy_check'], 'exactly one CHECK on the policy');
  const anchor = (await pool.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'content_ledger'::regclass AND conname = 'content_ledger_anchor_ref'`)).rowCount;
  assert.equal(anchor, 1, '094 anchor CHECK stays');
});

test('round 1: a published row blocks, the others are open', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 4);
  assert.deepEqual(await open(key, ids), ids);
  await publish(key, ids[1]);
  assert.deepEqual(await open(key, ids), [ids[0], ids[2], ids[3]]);
  assert.equal(await round(key), null, 'no round row: round 1 with no start');
  const v = await ledger.check(R1, ref(key, ids[1]));
  assert.equal(v.used && v.status, 'published');
  assert.equal((await ledger.check(R1, ref(key, ids[0]))).used, false);
  assert.equal((await ledger.check(R2, ref(key, ids[1]))).used, false, 'rounds are per resource: the other resource has not posted it');
});

test('publishing the last open row starts round 2 and every row is open, the one just posted included', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 3);
  await publish(key, ids[0]);
  await publish(key, ids[2]);
  assert.equal(await round(key), null);
  await publish(key, ids[1]);
  const r = await round(key);
  assert.equal(r?.round, 2);
  assert.deepEqual(await open(key, ids), ids, 'a new round frees all three');
  assert.equal((await ledger.check(R1, ref(key, ids[1]))).used, false, 'including the row posted last');
  // Round 2 is a round again: one post blocks only itself, the last one rolls to round 3.
  await publish(key, ids[1]);
  assert.deepEqual(await open(key, ids), [ids[0], ids[2]]);
  await publish(key, ids[0]);
  await publish(key, ids[2]);
  assert.equal((await round(key))?.round, 3);
  assert.deepEqual(await open(key, ids), ids);
});

test('rows added mid-round are open and keep the round going', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 2);
  await publish(key, ids[0]);
  await store.upsert(key, [{ num: 3, needs: 'x' }]);
  const all = await idsOf(key);
  assert.equal(all.length, 3);
  await publish(key, ids[1]);
  assert.equal(await round(key), null, 'the new row is still open: no roll');
  assert.deepEqual(await open(key, all), [all[2]]);
  await publish(key, all[2]);
  assert.equal((await round(key))?.round, 2);
});

test('hidden, unpostable and error-marked rows do not keep a round open', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 5, { postRequires: [['needs']] });
  // Row 1 is hidden, row 2 lost the field it needs (a merge is not blocked by the rule), row 3 is error-marked.
  await pool.query(`UPDATE data_items SET status = 'hidden' WHERE id = $1::bigint`, [ids[0]]);
  await pool.query(`UPDATE data_items SET data = data - 'needs' WHERE id = $1::bigint`, [ids[1]]);
  await ledger.record(ref(key, ids[2]), { resourceRef: R1, origin: 'editor', status: 'error', note: 'broken' });
  assert.deepEqual(await open(key, ids), [ids[0], ids[1], ids[3], ids[4]], 'the ledger only blocks the error row (the readers filter hidden / unpostable rows)');
  await publish(key, ids[3]);
  assert.equal(await round(key), null);
  await publish(key, ids[4]);
  assert.equal((await round(key))?.round, 2, 'rows 1–3 never counted');
});

test('an empty or all-unpostable dataset never rolls', { skip }, async () => {
  const empty = await mk(CYCLE, 0);
  assert.equal(await roll(empty.key), false);
  const { key, ids } = await mk(CYCLE, 2, { postRequires: [['needs']] });
  await pool.query(`UPDATE data_items SET data = data - 'needs' WHERE schema_id = (SELECT id FROM data_schemas WHERE key = $1)`, [key]);
  assert.equal(await roll(key), false, 'nothing open, nothing done');
  assert.equal(await round(key), null);
  assert.equal(ids.length, 2);
});

test('a row held by a waiting slot or an awaiting platform post does not keep the round open', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 3);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@pgt071_a', 'approve') ON CONFLICT DO NOTHING`);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ('@pgt071_a', CURRENT_DATE) RETURNING id`)).rows[0].id;
  // Row 3 waits for the owner on the Telegram channel; row 2 waits as a platform post on the other resource.
  await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec)
     VALUES ($1, '@pgt071_a', now() + interval '2 hours', 'text', 'x', 'awaiting_approval', $2)`, [plan, JSON.stringify({ library_ref: ref(key, ids[2]) })]);
  await pool.query(`INSERT INTO platform_posts (resource_ref, platform, format, caption, spec, source_ref, status) VALUES ($1, 'instagram', 'ig_photo', 'w', '{}', $2, 'awaiting_approval')`, [R2, ref(key, ids[1])]);
  await publish(key, ids[0]);
  await publish(key, ids[1]);
  assert.equal((await round(key))?.round, 2, 'on the Telegram channel row 3 is held, so rows 1 and 2 end the round');
  // The other resource: row 2 is held there, so posting rows 1 and 3 ends its round.
  await publish(key, ids[0], R2);
  assert.equal(await round(key, R2), null);
  await publish(key, ids[2], R2);
  assert.equal((await round(key, R2))?.round, 2);
});

test('passed ends a round, blocks only in the current round on its resource and never network-wide', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 3);
  await publish(key, ids[0]);
  await publish(key, ids[1]);
  assert.equal(await ledger.pass(ref(key, ids[2]), { resourceRef: R1, slotId: null, note: 'critic: no source' }), true);
  assert.equal((await round(key))?.round, 2, 'the passed row was the last open one');
  assert.deepEqual(await open(key, ids), ids, 'round 2: the passed row is open again');
  assert.equal((await ledger.check(R1, ref(key, ids[2]))).used, false);

  // In the round it was passed in, it blocks the same resource only.
  const b = await mk(CYCLE, 3);
  await ledger.pass(ref(b.key, b.ids[0]), { resourceRef: R1 });
  const v = await ledger.check(R1, ref(b.key, b.ids[0]));
  assert.equal(v.used && v.status, 'passed');
  assert.equal((await ledger.check(R2, ref(b.key, b.ids[0]))).used, false, 'not on another resource');
  assert.equal((await ledger.check(R2, ref(b.key, b.ids[0]), { scope: 'network' })).used, false, 'not network-wide');
  assert.equal((await ledger.check(R1, ref(b.key, b.ids[0]), { scope: 'network' })).used, false, 'passed has no network scope at all');
  assert.equal((await ledger.check(R1, ref(b.key, b.ids[0]), { publishedOnly: true })).used, false, 'the approval re-check only looks at publications');
});

test('pass ignores datasets that are not cycle datasets, and refs that are not data rows', { skip }, async () => {
  const never = await mk({ kind: 'never' }, 2);
  assert.equal(await ledger.pass(ref(never.key, never.ids[0]), { resourceRef: R1 }), false);
  const days = await mk({ kind: 'after_days', days: 30 }, 2);
  assert.equal(await ledger.pass(ref(days.key, days.ids[0]), { resourceRef: R1 }), false);
  assert.equal(await ledger.pass('https://pgt071.example/a', { resourceRef: R1 }), false);
  assert.equal(await ledger.pass('   ', { resourceRef: R1 }), false);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM content_ledger WHERE status = 'passed' AND source_ref LIKE 'data://pgt071_%' AND source_ref ~ $1`,
    [`^data://(${never.key}|${days.key})/`]);
  assert.equal(rows[0].n, 0, 'no passed rows written');
});

test('switching a used-up dataset to cycle frees it at once; switching back to never blocks it again', { skip }, async () => {
  // A pdr-like fixture: every row published months ago on one channel under `never`.
  const { key, ids } = await mk({ kind: 'never' }, 4);
  const monthsAgo = new Date(Date.now() - 140 * 86_400_000);
  for (const id of ids) await publish(key, id, R1, monthsAgo);
  assert.deepEqual(await open(key, ids), [], 'under never nothing is left');

  await store.updateSchema(key, { reuse_policy: CYCLE }, { changedBy: 'pgtest' });
  assert.equal((await round(key))?.round, 2, 'the switch started round 2 on the resource that used everything');
  assert.deepEqual(await open(key, ids), ids);
  assert.deepEqual(await open(key, ids, R2), ids);
  assert.equal(await round(key, R2), null, 'a resource that never used the dataset has no round row');

  await publish(key, ids[0]);
  assert.deepEqual(await open(key, ids), ids.slice(1));
  await store.updateSchema(key, { reuse_policy: { kind: 'never' } }, { changedBy: 'pgtest' });
  assert.deepEqual(await open(key, ids), [], 'back to never: every ledger row blocks again');
});

test('a partly used dataset keeps round 1 at the switch; a change of order or order_by keeps the rounds', { skip }, async () => {
  const { key, ids } = await mk({ kind: 'never' }, 4);
  await publish(key, ids[0]);
  await publish(key, ids[1]);
  await store.updateSchema(key, { reuse_policy: { kind: 'cycle', order: 'random' } }, { changedBy: 'pgtest' });
  assert.equal(await round(key), null, 'two rows are still open: round 1 goes on');
  assert.deepEqual(await open(key, ids), [ids[2], ids[3]], 'what was posted so far counts in round 1');
  await publish(key, ids[2]);
  await publish(key, ids[3]);
  assert.equal((await round(key))?.round, 2);
  await publish(key, ids[0]);
  const before = await round(key);
  await store.updateSchema(key, { reuse_policy: { kind: 'cycle', order: 'sequential', order_by: ['num'] } }, { changedBy: 'pgtest' });
  const after = await round(key);
  assert.equal(after?.round, 2, 'cycle to cycle keeps the round');
  assert.equal(after?.started_at.getTime(), before?.started_at.getTime());
  assert.deepEqual(await open(key, ids), [ids[1], ids[2], ids[3]], 'and what round 2 has posted');
});

test('rounds are per resource', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 2);
  await publish(key, ids[0], R1);
  await publish(key, ids[1], R1);
  assert.equal((await round(key, R1))?.round, 2);
  assert.equal(await round(key, R2), null, 'R2 is still in round 1');
  await publish(key, ids[0], R2);
  assert.deepEqual(await open(key, ids, R2), [ids[1]]);
  assert.deepEqual(await open(key, ids, R1), ids, 'R1 starts round 2 with both rows open');
});

test('network stats count a row as posted only within the round of the resource that posted it', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 3);
  const unposted = async () => {
    await pool.query(`SELECT data_schema_stats_refresh($1::uuid)`, [await schemaId(key)]);
    return Number((await pool.query(`SELECT unposted_network FROM data_schema_stats WHERE schema_id = $1`, [await schemaId(key)])).rows[0].unposted_network);
  };
  assert.equal(await unposted(), 3);
  await publish(key, ids[0], R1);
  await publish(key, ids[1], R2);
  assert.equal(await unposted(), 1, 'two rows are posted in round 1 of their resources');
  await ledger.pass(ref(key, ids[2]), { resourceRef: R1 });
  assert.equal(await unposted(), 1, 'passed never counts network-wide');
  // R1 finishes its round (ids[1] and the passed ids[2] were pending there): round 2 frees what R1 posted, R2 still holds ids[1].
  await publish(key, ids[1], R1);
  assert.equal((await round(key, R1))?.round, 2);
  assert.equal(await unposted(), 2, 'ids[0] and ids[2] are open again (R1 is in round 2); ids[1] is still posted in R2’s round 1');
});

test('shadowed rows hold a cycle row for 7 days on the same resource only', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 2);
  await ledger.record(ref(key, ids[0]), { resourceRef: R1, origin: 'editor', status: 'shadowed' });
  assert.deepEqual(await open(key, ids), [ids[1]]);
  assert.deepEqual(await open(key, ids, R2), ids);
  await ledger.record(ref(key, ids[1]), { resourceRef: R1, origin: 'editor', status: 'published' });
  assert.equal(await round(key), null, 'a shadowed row is not done: shadow mode never advances a round');
});

test('two concurrent publishes of the last rows start one round', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 3);
  await publish(key, ids[0]);
  // The same last row from two writers, then the last two rows of a round from two transactions at once.
  await Promise.all([publish(key, ids[1]), publish(key, ids[1])]);
  assert.equal(await round(key), null);
  await Promise.all([publish(key, ids[2]), publish(key, ids[2])]);
  assert.equal((await round(key))?.round, 2, 'one round started, not two');

  const b = await mk(CYCLE, 4);
  await publish(b.key, b.ids[0]);
  await publish(b.key, b.ids[1]);
  await Promise.all([publish(b.key, b.ids[2]), publish(b.key, b.ids[3])]);
  assert.equal((await round(b.key))?.round, 2, 'each transaction saw the other as open until the second one took the lock');
  assert.deepEqual(await open(b.key, b.ids), b.ids);
});

test('data_round_roll is a no-op for blank and wildcard resources and for datasets that are not cycle datasets', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 1);
  await publish(key, ids[0], 'telegram:*');
  for (const res of ['', '   ', '*', 'telegram:*']) assert.equal(await roll(key, res), false, JSON.stringify(res));
  assert.equal(await round(key, 'telegram:*'), null);
  const n = await mk({ kind: 'never' }, 1);
  await publish(n.key, n.ids[0]);
  assert.equal(await roll(n.key), false);
  // A publication on the legacy wildcard counts network-wide only: under a cycle policy the row is always counted.
  assert.deepEqual(await open(key, ids, R1), ids, 'the wildcard row does not block a real resource');
});

test('a ledger row is matched to its dataset by key, not by LIKE (an underscore is a wildcard)', { skip }, async () => {
  const under = await mk(CYCLE, 1, { key: 'pgt071_wild' });
  const plain = await mk(CYCLE, 1, { key: 'pgt071xwild' });
  // Nothing is open in `pgt071_wild` (its only row is hidden) and a row of the look-alike is published: with LIKE that
  // row would count as done in `pgt071_wild` and the round would roll.
  await pool.query(`UPDATE data_items SET status = 'hidden' WHERE id = $1::bigint`, [under.ids[0]]);
  await publish(plain.key, plain.ids[0]);
  assert.equal(await roll(under.key), false, 'nothing of pgt071_wild was posted');
  await pool.query(`UPDATE data_items SET status = 'active' WHERE id = $1::bigint`, [under.ids[0]]);
  assert.deepEqual(await open(under.key, under.ids), under.ids);
  await publish(under.key, under.ids[0]);
  assert.equal((await round(under.key))?.round, 2);
  assert.equal((await round(plain.key))?.round, 2);
});

test('the status CHECK knows passed; a repeat of a passed row moves used_at forward in the next round', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 2);
  await ledger.pass(ref(key, ids[0]), { resourceRef: R1, note: 'first' });
  await publish(key, ids[1]);
  assert.equal((await round(key))?.round, 2);
  await ledger.pass(ref(key, ids[0]), { resourceRef: R1, note: 'second' });
  const { rows } = await pool.query(`SELECT count(*)::int AS n, max(note) AS note FROM content_ledger WHERE status = 'passed' AND source_ref = $1`, [ref(key, ids[0])]);
  assert.equal(rows[0].n, 1, 'one passed row per (resource, ref)');
  assert.equal(rows[0].note, 'second');
  assert.deepEqual(await open(key, ids), [ids[1]], 'passed again in round 2');
  await assert.rejects(pool.query(`INSERT INTO content_ledger (resource_ref, source_ref, origin, status) VALUES ($1, 'x', 'editor', 'weird')`, [R1]), /content_ledger_status_check/);
});

test('the posted-marker trigger of a legacy strategy rolls a round too', { skip }, async () => {
  const { key, ids } = await mk(CYCLE, 2);
  await pool.query(`INSERT INTO tracked_channels (channel_key, channel_name, is_active) VALUES ('@pgt071_a', 'a', true) ON CONFLICT DO NOTHING`).catch(() => undefined);
  // A posted marker on the row (key = a Telegram channel key) reaches the ledger through trigger 060.
  await pool.query(`UPDATE data_items SET posted = posted || jsonb_build_object('@pgt071_a', now()) WHERE id = ANY ($1::bigint[])`, [ids]);
  assert.equal((await round(key))?.round, 2, 'every writer ends in the ledger trigger');
});
