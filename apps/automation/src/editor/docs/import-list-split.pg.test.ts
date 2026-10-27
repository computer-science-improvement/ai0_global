/**
 * Spec 070 FR-001 on a real database: the Apply of an import card over the (synthetic) road rules page cuts it into
 * clauses with `split_on`, creates `pdr_rules` (post_requires [[text]], refs by clause key) and writes one undoable import;
 * a re-sync repeats the stored split_on and, after one amended clause, updates exactly that row; the row's source_url and
 * its data ref land in the content ledger under the clause's anchor (spec 061), so a post written from the page for the
 * same clause is recognised. The page comes from an injected getter — no network. Own database (name p070_split) next to
 * EDITOR_PG_TEST_URL, dropped at the end. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ContentLedger } from '../../data/content-ledger';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { buildPlan, IMPORT_LIST_KIND, listImports, payloadOf, RESYNC_IMPORT_KIND } from './import-list';
import { importActionHandlers } from './import-list-tools';
import { PDR_HTML, PDR_MAPPING, PDR_SPLIT_ON, PDR_URL } from './testing/pdr-fixture';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;

let body = PDR_HTML;
let hits = 0;
const http = {
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  get: async () => { hits++; return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: body }; },
};
const docs = new DocStore();
const deps = () => ({ pool, docs, http, pageDelayMs: 0 });

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p070_split');
  pool = db.pool;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

const rules = async () => (await pool.query(
  `SELECT d.id, d.data, data_postable(s.post_requires, d.data) AS postable FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
    WHERE s.key = 'pdr_rules' ORDER BY d.id`)).rows;

test('Apply cuts the page into clauses, creates pdr_rules and stores split_on for the re-sync', { skip }, async () => {
  const r: any = await fetchDocument(PDR_URL, { docs, http });
  const plan = buildPlan(r.doc, { dataset: 'pdr_rules', mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'Road rules' }, null);
  const payload = payloadOf(plan, 'pdr_rules');
  assert.equal(payload.split_on, PDR_SPLIT_ON);
  assert.equal(payload.expected, 8);

  const res: any = await importActionHandlers(deps())[IMPORT_LIST_KIND](payload as any);
  assert.equal(res.created_dataset, true);
  assert.equal(res.inserted, 8);
  assert.equal(res.not_postable, 0);

  const schema = (await pool.query(`SELECT post_requires, dedup_key, fields, roles FROM data_schemas WHERE key = 'pdr_rules'`)).rows[0];
  assert.deepEqual(schema.post_requires, [['text']]);
  assert.deepEqual(schema.dedup_key, ['list_ref']);
  const searchable = (schema.fields as Array<{ name: string; searchable?: boolean }>).filter((f) => f.searchable).map((f) => f.name).sort();
  assert.deepEqual(searchable, ['category', 'text', 'title']);
  assert.equal(schema.roles.body, 'text');

  const all = await rules();
  assert.equal(all.length, 8);
  assert.ok(all.every((x) => x.postable === true));
  const clause = all.find((x) => x.data.clause === '14.6')!;
  assert.equal(clause.data.title, 'Обгін заборонено:');
  assert.equal(clause.data.category, '14. ОБГІН');
  assert.equal(clause.data.source_url, `${PDR_URL}#п.14.6`);
  assert.equal(clause.data.list_ref, `${PDR_URL}#14.6`);
  assert.match(clause.data.text, /^14\.6\. Обгін заборонено:\nа\) на регульованих перехрестях;/);
  assert.ok(!/Пункт 14\.6/.test(clause.data.text), 'the editorial note is not part of the text');
  assert.deepEqual(all.filter((x) => x.data.clause === '1.1').map((x) => x.data.list_ref).sort(), [`${PDR_URL}#1.1`, `${PDR_URL}#1.1 (2)`]);

  const [li] = await listImports(pool, 'pdr_rules');
  assert.equal(li.options.split_on, PDR_SPLIT_ON);
  assert.equal(li.options.level, 0);
  assert.deepEqual(li.options.required, ['text']);
});

test('a re-sync reads the page again with the stored split_on and updates only the amended clause', { skip }, async () => {
  hits = 0;
  const same: any = await importActionHandlers(deps())[RESYNC_IMPORT_KIND]({ dataset: 'pdr_rules' });
  assert.equal(hits, 1, 'a re-sync fetches fresh');
  assert.deepEqual([same.inserted, same.updated, same.import_id], [0, 0, null], 'nothing changed');

  body = PDR_HTML.replace('Правила поширюються на всіх учасників дорожнього руху.', 'Правила поширюються на всіх учасників дорожнього руху, включно з пішоходами.');
  const res: any = await importActionHandlers(deps())[RESYNC_IMPORT_KIND]({ dataset: 'pdr_rules' });
  assert.deepEqual([res.inserted, res.updated], [0, 1]);
  const all = await rules();
  assert.equal(all.length, 8);
  assert.match(all.find((x) => x.data.clause === '1.2')!.data.text, /включно з пішоходами/);
});

test('the clause row and a post written from the page for the same clause meet in the content ledger', { skip }, async () => {
  const ledger = new ContentLedger(pool, undefined, () => ['zakon.rada.gov.ua']);
  const row = (await rules()).find((x) => x.data.clause === '14.6')!;
  const resource = 'telegram:@pdr070';
  const added = await ledger.recordRefs([`data://pdr_rules/${row.id}`, row.data.source_url], { resourceRef: resource, origin: 'editor', status: 'published' });
  assert.equal(added, 2);
  const { rows } = await pool.query(`SELECT source_ref, anchor FROM content_ledger WHERE resource_ref = $1 ORDER BY source_ref`, [resource]);
  assert.deepEqual(rows.map((r) => r.anchor), [null, 'п.14.6']);
  assert.equal(rows[0].source_ref, `data://pdr_rules/${row.id}`);
  assert.equal(rows[1].source_ref, `${PDR_URL}#п.14.6`);
  const page = await ledger.check(resource, `${PDR_URL}#п.14.6`, { waiting: true });
  assert.equal(page.used, true, 'the same clause, asked for by its page address and anchor');
  assert.deepEqual(await ledger.check(resource, `${PDR_URL}#п.14.1`, { waiting: true }), { used: false }, 'another clause of the page is free');
});
