/**
 * Spec 071 T2 against a throwaway Postgres with every migration applied (migration 096): the round order of queryDataset
 * (typed order_by, per resource, category scope), the random round's 7-day tail, the lazy roll of query_data / the catalog /
 * nextInRound, passRow, the A7 source guard on real ledger rows, and the `reuse` suggestion switching a used-up dataset.
 * Creates its own database next to EDITOR_PG_TEST_URL and drops it. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ContentLedger } from './content-ledger';
import { buildCatalog } from './data-catalog';
import { nextInRound, queryDataset } from './data-query';
import { DataStore } from './data-store';
import type { DataSchema, ReusePolicy } from './data.types';
import { createMigratedDb, type FreshDb } from '../editor/sysadmin/testing/fresh-db';
import { buildDataTools, applyDataSchemaSuggestion } from '../editor/tools/data-tools';
import { catalogOverview, catalogPromptSummary } from '../editor/tools/catalog-context';
import { sourceGuard } from '../editor/tools/role-tools';
import { makePassRow } from '../editor/silent/pass-row';
import { nextRowPort } from '../editor/schedule/next-row';
import { reuseText } from './data-catalog';
import { makeSpec } from '../editor/post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const R1 = 'telegram:@pgt071r_a';
const R2 = 'instagram:pgt071r-b';
const TODAY = { month: 3, day: 9 };

let db: FreshDb;
let pool: Pool;
let store: DataStore;
let ledger: ContentLedger;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'r071r');
  pool = db.pool;
  store = new DataStore(pool);
  ledger = new ContentLedger(pool);
});
after(async () => { await db?.drop(); });

let seq = 0;
interface Row { num?: number | null; label?: string; kind?: string }
/** A dataset of the given rows (import order = array order); returns the schema and the row ids in import order. */
async function mk(policy: ReusePolicy, rows: Row[], opts: { postRequires?: string[][] } = {}) {
  const key = `pgt071r_${++seq}`;
  await store.createSchema({
    key, title: key, description: 'rounds read test', entity: 'item',
    fields: [
      { name: 'num', type: 'int', description: 'Number' }, { name: 'label', type: 'text', description: 'Label' }, { name: 'kind', type: 'text', description: 'Kind' },
    ],
    roles: { title: 'label', category: 'kind' }, dedup_key: [], language: 'uk', default_license: 'own', reuse_policy: policy,
    suitable_for: 'tests', contains_personal_data: false, status: 'active', ...(opts.postRequires ? { post_requires: opts.postRequires } : {}),
  } as any, 'pgtest');
  const res = await store.upsert(key, rows as any);
  assert.equal(res.inserted, rows.length, JSON.stringify(res));
  const { rows: ids } = await pool.query(`SELECT d.id::text AS id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 ORDER BY d.id`, [key]);
  return { key, ids: ids.map((r) => r.id as string), schema: (await store.getSchema(key)) as DataSchema };
}
const ref = (key: string, id: string) => `data://${key}/${id}`;
const publish = (key: string, id: string, resource = R1, usedAt?: Date) => ledger.record(ref(key, id), { resourceRef: resource, origin: 'editor', status: 'published', usedAt });
const labels = async (schema: DataSchema, resource: string | null, o: Record<string, unknown> = {}) => {
  const r = await queryDataset(pool, schema, { audience: 'owner', limit: 20, today: TODAY, unpostedOn: resource, fields: ['label'], ...o });
  return { labels: r.rows.map((x: any) => x.data.label as string), ordered: r.ordered, total: r.total };
};

test('sequential round order: order_by typed (numbers as numbers, NULLS LAST), then import order; per resource; filters and search keep it', { skip }, async () => {
  const { schema, key, ids } = await mk({ kind: 'cycle', order: 'sequential', order_by: ['num', 'label'] }, [
    { num: 10, label: 'b' }, { num: 2, label: 'z' }, { num: 10, label: 'a' }, { label: 'q' }, { num: 2, label: 'a' }, { num: 10, label: 'a' },
  ]);
  const all = await labels(schema, R1, { withTotal: true });
  // 2 < 10 as numbers (as text "10" would sort first); the row without a number goes last; equal keys keep import order.
  assert.deepEqual(all.labels, ['a', 'z', 'a', 'a', 'b', 'q']);
  assert.equal(all.ordered, true);
  assert.equal(all.total, 6, 'the count query still runs with the extra ORDER BY placeholders');
  const idOrder = (await queryDataset(pool, schema, { audience: 'owner', limit: 20, today: TODAY, unpostedOn: R1, fields: ['num'] })).rows.map((r: any) => r.id);
  assert.deepEqual(idOrder, [ids[4], ids[1], ids[2], ids[5], ids[0], ids[3]], 'the two (10, a) rows keep import order');

  // Per resource: R1 posted the first; R2 starts from the beginning.
  await publish(key, ids[4]);
  assert.deepEqual((await labels(schema, R1)).labels, ['z', 'a', 'a', 'b', 'q']);
  assert.deepEqual((await labels(schema, R2)).labels, ['a', 'z', 'a', 'a', 'b', 'q']);
  // Next within a filter / a search is the next within it.
  assert.deepEqual((await labels(schema, R1, { search: 'a' })).labels.slice(0, 2), ['a', 'a']);
  // The explicit order from the agent does not override; without a resource it is not a round order.
  assert.equal((await labels(schema, R1, { order: 'newest' })).labels[0], 'z');
  assert.equal((await labels(schema, null)).ordered, undefined);
});

test('nextInRound: the first open row, within a category; null for a random or stock dataset', { skip }, async () => {
  const { schema, key, ids } = await mk({ kind: 'cycle', order: 'sequential' }, [
    { label: 'a1', kind: 'A' }, { label: 'b1', kind: 'B' }, { label: 'a2', kind: 'A' }, { label: 'b2', kind: 'B' },
  ]);
  assert.deepEqual(await nextInRound(pool, schema, R1, TODAY), { ref: ref(key, ids[0]), rolled: false });
  assert.equal((await nextInRound(pool, schema, R1, TODAY, 'B')).ref, ref(key, ids[1]));
  assert.equal((await nextInRound(pool, schema, R1, TODAY, 'b')).ref, ref(key, ids[1]), 'case-insensitive, exact category');
  await publish(key, ids[1]);
  assert.equal((await nextInRound(pool, schema, R1, TODAY, 'B')).ref, ref(key, ids[3]));
  assert.equal((await nextInRound(pool, schema, R1, TODAY)).ref, ref(key, ids[0]));
  assert.equal((await nextInRound(pool, schema, R2, TODAY, 'B')).ref, ref(key, ids[1]), 'the other resource is at the start');
  // A row held by a slot waiting for approval is not offered either.
  const rnd = await mk({ kind: 'cycle', order: 'random' }, [{ label: 'x' }]);
  assert.deepEqual(await nextInRound(pool, rnd.schema, R1, TODAY), { ref: null, rolled: false });
  const stock = await mk({ kind: 'never' }, [{ label: 'x' }]);
  assert.equal((await nextInRound(pool, stock.schema, R1, TODAY)).ref, null);
  // The schedule port: schema lookup + the same answer; unknown dataset → null.
  const port = nextRowPort(pool, () => TODAY);
  assert.equal(await port(R1, key, 'B'), ref(key, ids[3]));
  assert.equal(await port(R1, 'pgt071r_missing', null), null);
  assert.equal(await port(R1, stock.key, null), null);
});

test('random round: the rows posted on the resource in the last 7 days go last in the next round; an old post does not', { skip }, async () => {
  const { schema, key, ids } = await mk({ kind: 'cycle', order: 'random' }, [{ label: 'old' }, { label: 'mid' }, { label: 'fresh' }]);
  const day = 86_400_000;
  await publish(key, ids[0], R1, new Date(Date.now() - 30 * day));
  await publish(key, ids[1], R1, new Date(Date.now() - 20 * day));
  await publish(key, ids[2], R1, new Date(Date.now() - 1 * day));   // the last one rolls the round
  const { rows: rr } = await pool.query(`SELECT round FROM data_reuse_rounds r JOIN data_schemas s ON s.id = r.schema_id WHERE s.key = $1 AND r.resource_ref = $2`, [key, R1]);
  assert.equal(rr[0].round, 2);
  const first = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const r = (await labels(schema, R1)).labels;
    assert.equal(r.length, 3, 'a new round: all three are open');
    assert.equal(r[2], 'fresh', 'last week\'s row goes last');
    first.add(r[0]);
  }
  assert.deepEqual([...first].sort(), ['mid', 'old'], 'the other two are shuffled');
  assert.equal((await labels(schema, R1, { order: 'newest' })).labels[0], 'fresh', 'an explicit newest is kept');
  assert.equal((await labels(schema, R2)).labels.length, 3, 'the other resource has no tail');
});

test('lazy roll: a read that finds nothing asks the database to roll (query_data, library_catalog, nextInRound) — the rule is the database\'s', { skip }, async () => {
  const tools = Object.fromEntries(buildDataTools({ pool, today: () => TODAY }).map((t) => [t.name, t]));
  const ctx = { runId: 'r', role: 'executor' as const, channelKey: '@pgt071r_a' };
  const roundOf = async (key: string) => (await pool.query(`SELECT r.round FROM data_reuse_rounds r JOIN data_schemas s ON s.id = r.schema_id WHERE s.key = $1 AND r.resource_ref = $2`, [key, R1])).rows[0]?.round ?? 1;
  const staged = async () => {
    const m = await mk({ kind: 'cycle', order: 'sequential' }, [{ label: 'r0' }, { label: 'r1' }, { label: 'r2' }]);
    await publish(m.key, m.ids[0]);
    await publish(m.key, m.ids[1]);
    // The last open row leaves the dataset without a ledger event (the owner hides it): nothing rolled yet.
    await pool.query(`UPDATE data_items SET status = 'hidden' WHERE id = $1`, [m.ids[2]]);
    assert.equal(await roundOf(m.key), 1);
    return m;
  };

  const a = await staged();
  const q: any = await tools.query_data.execute({ schema: a.key, fields: ['label'], filters: [], order: 'random', limit: 5, full: false }, ctx);
  assert.deepEqual(q.rows.map((r: any) => r.label), ['r0', 'r1']);
  assert.equal(q.next, ref(a.key, a.ids[0]));
  assert.deepEqual(q.repeat, { order: 'sequential', round: 2 });
  assert.match(q.note, /щойно почалось нове коло/);
  assert.equal(await roundOf(a.key), 2);

  const b = await staged();
  const [e] = await buildCatalog(pool, { dataset: b.key, resource: R1, today: TODAY });
  assert.equal(e.unposted_here, 2);
  assert.deepEqual(e.repeat, { order: 'sequential', round: 2 });
  assert.equal(await roundOf(b.key), 2);
  const [none] = await buildCatalog(pool, { dataset: b.key, today: TODAY });
  assert.deepEqual(none.repeat, { order: 'sequential' }, 'no resource, no round');

  const c = await staged();
  assert.deepEqual(await nextInRound(pool, c.schema, R1, TODAY), { ref: ref(c.key, c.ids[0]), rolled: true });

  // A filter that matches nothing while rows are open must not roll.
  const d = await mk({ kind: 'cycle', order: 'sequential' }, [{ label: 'x' }, { label: 'y' }]);
  await publish(d.key, d.ids[0]);
  const f: any = await tools.query_data.execute({ schema: d.key, fields: ['label'], filters: [], search: 'nomatch-zzz', order: 'random', limit: 5, full: false }, ctx);
  assert.deepEqual(f.rows, []);
  assert.match(f.note, /nothing left in this round here/);
  assert.equal(await roundOf(d.key), 1, 'a row is still open: no new round');

  // Every row unpostable: no loop, and the note says why.
  const u = await mk({ kind: 'cycle', order: 'sequential' }, [{ label: 'x' }, { label: 'y' }], { postRequires: [['label']] });
  await pool.query(`UPDATE data_items SET data = data - 'label' WHERE schema_id = (SELECT id FROM data_schemas WHERE key = $1)`, [u.key]);   // the import refuses such rows; an edit can leave them
  const uq: any = await tools.query_data.execute({ schema: u.key, fields: ['label'], filters: [], order: 'random', limit: 5, full: false }, ctx);
  assert.deepEqual(uq.rows, []);
  assert.match(uq.note, /every one of the 2 rows of this dataset lacks what a post needs/);
  assert.equal(await roundOf(u.key), 1);
});

test('catalog overview and the prompt summary for a real cycle dataset: round line, no runway', { skip }, async () => {
  const m = await mk({ kind: 'cycle', order: 'sequential' }, [{ label: 'a' }, { label: 'b' }, { label: 'c' }]);
  await publish(m.key, m.ids[0]);
  const o = await catalogOverview(pool, { resource: R1, today: TODAY });
  const row = o.datasets.find((d) => d.dataset === m.key)!;
  assert.deepEqual([row.repeat, row.unposted_here, row.runway_days], [{ order: 'sequential', round: 1 }, 2, null]);
  const line = catalogPromptSummary({ datasets: [row], apis: [], feeds: [] }).split('\n').find((l) => l.startsWith(`• ${m.key}`))!;
  assert.match(line, /— по колу \(по черзі\), коло 1: лишилось 2 з 3$/);
});

test('passRow puts a row aside on the slot\'s resource: it ends the round, comes back in the next, and the guard says why', { skip }, async () => {
  const m = await mk({ kind: 'cycle', order: 'sequential' }, [{ label: 'good' }, { label: 'broken' }]);
  const pass = makePassRow(ledger);
  const slot = { id: '00000000-0000-4000-8000-000000000071', channelKey: '@pgt071r_a', resourceRef: R1 };
  assert.equal(await pass(slot, ref(m.key, m.ids[1]), 'critic_rejected: no source'), true);
  assert.equal((await nextInRound(pool, m.schema, R1, TODAY)).ref, ref(m.key, m.ids[0]), 'the passed row is out of this round');
  assert.equal((await nextInRound(pool, m.schema, R2, TODAY)).ref, ref(m.key, m.ids[0]));
  const plans: any = {
    sourceAlreadyPosted: (ch: string, r: string) => ledger.used(ch, r, { waiting: true }),
    sourceVerdict: (ch: string, r: string) => ledger.check(ch, r, { waiting: true }),
  };
  const g: any = await sourceGuard({ plans, pool }, '@pgt071r_a', makeSpec({ origin: 'library', library_ref: ref(m.key, m.ids[1]), source: undefined }));
  assert.equal(g.error, 'library_item_already_posted');
  assert.match(g.details, /пропущене в цьому колі/);
  // Publishing the good row finishes the round (good: done, broken: passed) → round 2, both open again.
  await publish(m.key, m.ids[0]);
  assert.equal((await nextInRound(pool, m.schema, R1, TODAY)).ref, ref(m.key, m.ids[0]));
  assert.equal(await sourceGuard({ plans, pool }, '@pgt071r_a', makeSpec({ origin: 'library', library_ref: ref(m.key, m.ids[1]), source: undefined })), null, 'the broken row is back');
  // A stock dataset: nothing recorded.
  const stock = await mk({ kind: 'never' }, [{ label: 'x' }]);
  assert.equal(await pass(slot, ref(stock.key, stock.ids[0]), 'r'), false);
  assert.equal((await pool.query(`SELECT 1 FROM content_ledger WHERE source_ref = $1`, [ref(stock.key, stock.ids[0])])).rowCount, 0);
});

test('A7 on real ledger rows: the URL a cycle row cited in round 1 does not stop the same row in round 2; under never it does', { skip }, async () => {
  const LAW = 'https://example.org/laws/a071-test';
  const plans: any = {
    sourceAlreadyPosted: (ch: string, r: string) => ledger.used(ch, r, { waiting: true }),
    sourceVerdict: (ch: string, r: string) => ledger.check(ch, r, { waiting: true }),
  };
  const post = (key: string, id: string) => makeSpec({ origin: 'library', library_ref: ref(key, id), source: { url: LAW, name: 'Закон' } });
  const cyc = await mk({ kind: 'cycle', order: 'sequential' }, [{ label: 'q1' }, { label: 'q2' }]);
  // Round 1: both rows go out, each citing the same URL (recorded as published too).
  for (const id of cyc.ids) { await publish(cyc.key, id); await ledger.record(LAW, { resourceRef: R1, origin: 'editor', status: 'published' }); }
  assert.equal((await pool.query(`SELECT r.round FROM data_reuse_rounds r JOIN data_schemas s ON s.id = r.schema_id WHERE s.key = $1`, [cyc.key])).rows[0].round, 2);
  assert.equal((await ledger.check(R1, LAW)).used, true, 'the URL itself stays used for ever');
  assert.equal(await sourceGuard({ plans, pool }, '@pgt071r_a', post(cyc.key, cyc.ids[0])), null, 'round 2: the open row passes although its URL was used');
  // The same shape under never: the row is open (fresh), the URL is used → refused.
  const nv = await mk({ kind: 'never' }, [{ label: 'q1' }]);
  const r: any = await sourceGuard({ plans, pool }, '@pgt071r_a', post(nv.key, nv.ids[0]));
  assert.equal(r.error, 'source_already_posted');
});

test('the reuse suggestion switches a used-up dataset at once: every row is open again; switching back blocks them', { skip }, async () => {
  const m = await mk({ kind: 'never' }, [{ label: 'a' }, { label: 'b' }, { label: 'c' }]);
  for (const id of m.ids) await publish(m.key, id, R1, new Date(Date.now() - 90 * 86_400_000));
  assert.equal((await labels(m.schema, R1)).labels.length, 0, 'never: used up for ever');
  const payload = (reuse: ReusePolicy, from: ReusePolicy) => ({
    dataset: m.key, target: 'reuse', field: null, reuse, old_text: reuseText(from), new_text: reuseText(reuse), evidence: 'The owner asked for this dataset to go round in order.',
  });
  const res = await applyDataSchemaSuggestion(store, payload({ kind: 'cycle', order: 'sequential' }, { kind: 'never' }));
  assert.equal(res.dataset, m.key);
  const now = (await store.getSchema(m.key))!;
  assert.deepEqual(now.reuse_policy, { kind: 'cycle', order: 'sequential' });
  assert.deepEqual((await labels(now, R1)).labels, ['a', 'b', 'c'], 'the switch rolled round 1 → 2: all three are open, in order');
  assert.equal(now.version, m.schema.version, 'a reuse edit keeps the version');
  // Stale: the same suggestion again (the policy is cycle now, the old text no longer matches).
  await assert.rejects(applyDataSchemaSuggestion(store, payload({ kind: 'cycle', order: 'sequential' }, { kind: 'never' })), /stale/);
  // A bad order_by is refused by the store.
  await assert.rejects(applyDataSchemaSuggestion(store, payload({ kind: 'cycle', order: 'sequential', order_by: ['ghost'] }, { kind: 'cycle', order: 'sequential' })), /unknown field ghost/);
  // Back to never: the published rows block again.
  await applyDataSchemaSuggestion(store, payload({ kind: 'never' }, { kind: 'cycle', order: 'sequential' }));
  assert.equal((await labels((await store.getSchema(m.key))!, R1)).labels.length, 0);
});
