/**
 * Spec 068 FR-008 against a throwaway Postgres (every migration applied): query_data by ref on real rows — a hidden row, a row
 * that misses post_requires, a used row, a legacy alias, a ref with no row — and the zero-hit notes. Own schema key (pgt068r_*),
 * removed at the end. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DataStore } from '../../data/data-store';
import { ContentLedger } from '../../data/content-ledger';
import { buildDataTools, QueryDataInput } from './data-tools';
import type { ToolContext } from '../harness/tool';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K = 'pgt068r_prompts';
const CH = '@pgt068r';
const REF = `telegram:${CH}`;
const LEGACY = 'library://pgtold/pgt068r-a';
let pool: Pool;
const id: Record<string, string> = {};

async function cleanup() {
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt068r\\_%')`);
  await pool.query(`DELETE FROM data_imports WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt068r\\_%')`);
  await pool.query(`DELETE FROM data_schemas WHERE key LIKE 'pgt068r\\_%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const store = new DataStore(pool);
  await store.createSchema({
    key: K, title: 'Prompts', description: 'test', entity: 'prompt', roles: { title: 'name', body: 'prompt_text', image: 'media_url' },
    fields: [
      // The dataset's own `id` field: a CDN URL, not filterable — the thing the executor tried to filter on.
      { name: 'id', type: 'url', description: 'Image address' },
      { name: 'name', type: 'text', description: 'Name', required: true },
      { name: 'prompt_text', type: 'long_text', description: 'Prompt text', searchable: true },
      { name: 'media_url', type: 'image_url', description: 'Image' },
      { name: 'category', type: 'text', description: 'Category', filterable: true },
    ],
    dedup_key: ['name'], default_license: 'own', reuse_policy: { kind: 'never' }, post_requires: [['prompt_text'], ['media_url']],
    suitable_for: '', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  const full = (name: string) => ({ id: `https://cdn.example/${name}.png`, name, prompt_text: `prompt ${name}`, media_url: `https://cdn.example/${name}.png`, category: 'flux' });
  const r = await store.upsert(K, ['a', 'b', 'c', 'hidden', 'bare'].map(full));
  assert.equal(r.inserted, 5, JSON.stringify(r.invalid));
  for (const x of (await pool.query(`SELECT d.id::text AS id, d.data->>'name' AS name FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1`, [K])).rows) id[x.name] = x.id;
  await pool.query(`UPDATE data_items SET data = data - 'prompt_text' WHERE id = $1::bigint`, [id.bare]);
  await pool.query(`UPDATE data_items SET status = 'hidden' WHERE id = $1::bigint`, [id.hidden]);
  await pool.query(`UPDATE data_items SET legacy_ref = $2 WHERE id = $1::bigint`, [id.a, LEGACY]);
  await new ContentLedger(pool).record(`data://${K}/${id.c}`, { resourceRef: REF, origin: 'editor', status: 'published' });
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: CH };
const queryData = () => buildDataTools({ pool, today: () => ({ month: 10, day: 27 }) }).find((t) => t.name === 'query_data')!;
const ref = (name: string) => `data://${K}/${id[name]}`;
const run = (i: Record<string, unknown>, c: ToolContext = ctx) => queryData().execute(QueryDataInput.parse({ schema: K, fields: ['name'], ...i }), c) as Promise<any>;

test('by ref: the rows asked for, in order, any status, with postable / missing / used_here; a ref with no row is found: false', { skip }, async () => {
  const r = await run({ refs: [ref('c'), ref('bare'), ref('hidden'), LEGACY, `data://${K}/999999999`, ref('a')] });
  assert.deepEqual(r.rows, [
    { ref: ref('c'), name: 'c', postable: true, missing: [], used_here: true },
    { ref: ref('bare'), name: 'bare', postable: false, missing: ['prompt_text'], used_here: false },
    { ref: ref('hidden'), name: 'hidden', status: 'hidden', postable: false, missing: ['status: hidden'], used_here: false },
    { ref: ref('a'), name: 'a', postable: true, missing: [], used_here: false, requested: LEGACY },
    { ref: `data://${K}/999999999`, found: false },
    { ref: ref('a'), name: 'a', postable: true, missing: [], used_here: false },
  ]);
  assert.match(r.note, /1 ref\(s\) have no row/);
  assert.match(r.note, /2 row\(s\) have postable: false/, 'the hidden row (status) and the one without prompt text');
});

test('by ref: filters, search and unposted_on are not applied; without a resource there is no used_here; the dataset must match', { skip }, async () => {
  const r = await run({ refs: [ref('bare')], filters: [{ field: 'category', op: 'eq', value: 'other' }], search: 'nothing like it', unposted_on: null });
  assert.deepEqual(r.rows, [{ ref: ref('bare'), name: 'bare', postable: false, missing: ['prompt_text'] }]);
  const other = await run({ refs: ['data://pgt068r_other/1'] });
  assert.equal(other.error, 'ref_dataset_mismatch');
});

test('the usual query still drops hidden, unpostable and used rows; id filters say how to use refs', { skip }, async () => {
  const r = await run({ order: 'oldest' });
  assert.deepEqual(r.rows.map((x: any) => x.name), ['a', 'b'], 'hidden, bare (no text) and c (used here) are not offered');
  const bad = await run({ filters: [{ field: 'id', op: 'eq', value: 'https://cdn.example/a.png' }] });
  assert.equal(bad.error, 'field_not_filterable');
  assert.match(bad.details, /refs: \["data:\/\/<dataset>\/<id>"\]/);
});

test('zero hits on real rows: used rows, nothing matching at all, the field may be empty', { skip }, async () => {
  const used = await run({ filters: [{ field: 'category', op: 'eq', value: 'flux' }], search: 'prompt c' });
  assert.equal(used.rows.length, 0);
  assert.equal(used.note, 'nothing left that is unposted here with these filters; loosen the filters or pick another dataset');
  const none = await run({ filters: [{ field: 'category', op: 'eq', value: 'no-such' }] });
  assert.match(none.note, /no rows match these filters or this search, used or not/);
  const noResource = await run({ filters: [{ field: 'category', op: 'eq', value: 'no-such' }], unposted_on: null });
  assert.equal(noResource.note, 'no rows match these filters');
});
