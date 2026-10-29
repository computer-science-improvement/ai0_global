/**
 * Spec 076 T6b on a real database: an import made from an uploaded page is re-synced from memory and by hand. The page of the
 * road rules (the § 29 `split_on` mapping) is imported live once; an upload with `dataset` then re-syncs it without a request,
 * a run that changes nothing still marks the import `uploaded`, and from then on the weekly job skips it, `resync_import`
 * answers `resync_manual`, and an Apply whose upload is gone (a restart) fails with `upload_expired`. The stubbed `get` counts
 * every request: after the first import it must never move. Creates its own database next to EDITOR_PG_TEST_URL (init.sql +
 * every migration) and drops it. Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { pgDbName, pgWithDb } from '../../common/testing/pg-test-url';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { buildPlan, IMPORT_LIST_KIND, listImports, payloadOf, RESYNC_IMPORT_KIND, resyncDataset, runImport } from './import-list';
import { buildImportListTools, importActionHandlers } from './import-list-tools';
import { resyncAll } from './list-resync.worker';
import { PDR_HTML, PDR_MAPPING, PDR_SPLIT_ON, PDR_URL } from './testing/pdr-fixture';
import { UploadPageBody, uploadPage } from '../sources/upload-page';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');

let admin: Client;
let pool: Pool;
let dbName: string;

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
let gets = 0;
/** The site as the server sees it before the owner needs the upload: it answers. */
const live = { lookup, get: async () => { gets++; return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: PDR_HTML }; } };
/** The site as it is when the upload is needed: the request never completes. Nothing may call it. */
const blocked = { lookup, get: async (): Promise<never> => { gets++; throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }); } };
const ctx = { runId: 'r', role: 'composer', channelKey: null, extras: {} };

const NEW_CLAUSE_PAGE = PDR_HTML.replace('<p>1.6. Учасники', '<p>1.3. Нова вимога, додана пізніше.</p>\n<p>1.6. Учасники');
const args = (dataset: string) => ({ dataset, mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'ПДР', license: undefined });

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${pgDbName(url)}_u076_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new Client({ connectionString: pgWithDb(url, dbName) });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query('BEGIN');
      try { await c.query(readFileSync(join(MIGRATIONS, f), 'utf8')); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.end();
  }
  pool = new Pool({ connectionString: pgWithDb(url, dbName), max: 4 });
});

after(async () => {
  if (!url) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  await admin.end();
});

const count = async (dataset: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1`, [dataset])).rows[0].n as number;
const imports = async () => (await pool.query(`SELECT count(*)::int AS n FROM data_imports`)).rows[0].n as number;

/** The first import of a dataset: live, as it was before the site stopped answering. */
async function importLive(dataset: string): Promise<string> {
  const docs = new DocStore();
  const r: any = await fetchDocument(PDR_URL, { docs, http: live });
  const plan = buildPlan(r.doc, args(dataset), null);
  const res: any = await importActionHandlers({ pool, docs, http: live })[IMPORT_LIST_KIND](payloadOf(plan, dataset) as any);
  assert.equal(res.created_dataset, true);
  assert.equal(res.inserted, 8);
  return res.import_id;
}

test('a live import is auto re-synced and not marked uploaded', { skip }, async () => {
  const importId = await importLive('pdr_rules');
  const [li] = await listImports(pool, 'pdr_rules');
  assert.equal(li.import_id, importId);
  assert.equal(li.options.auto_resync, true);
  assert.equal(li.options.uploaded, undefined);
});

test('an upload with dataset re-syncs from memory with no request, and the import is marked uploaded', { skip }, async () => {
  const requests = gets;
  const docs = new DocStore();   // a new process: the live copy is not there
  const res: any = await uploadPage({ docs, imports: { pool, http: blocked } }, UploadPageBody.parse({ url: PDR_URL, content: NEW_CLAUSE_PAGE, dataset: 'pdr_rules' }));
  assert.equal(res.error, undefined, JSON.stringify(res));
  assert.equal(res.dataset, 'pdr_rules');
  assert.equal(res.inserted, 1, 'the new clause only');
  assert.equal(res.updated, 0);
  assert.ok(res.import_id, 'undoable like any import');
  assert.equal(gets, requests, 'no request was made');
  assert.equal(await count('pdr_rules'), 9);
  const [li] = await listImports(pool, 'pdr_rules');
  assert.equal(li.import_id, res.import_id);
  assert.equal(li.options.uploaded, true);
  assert.equal(li.options.auto_resync, false);
  assert.equal(li.options.split_on, PDR_SPLIT_ON, 'the same extraction ran again');
});

test('a zero-change re-sync from an upload still marks the import, and leaves no import row of its own', { skip }, async () => {
  const firstImport = await importLive('pdr_zero');
  const [before] = await listImports(pool, 'pdr_zero');
  assert.equal(before.options.uploaded, undefined);
  const rowsBefore = await imports();
  const requests = gets;
  const res: any = await uploadPage({ docs: new DocStore(), imports: { pool, http: blocked } }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML, dataset: 'pdr_zero' }));
  assert.equal(res.error, undefined, JSON.stringify(res));
  assert.deepEqual([res.inserted, res.updated, res.import_id], [0, 0, null]);
  assert.equal(await imports(), rowsBefore, 'nothing changed, so no import row');
  assert.equal(gets, requests);
  const [li] = await listImports(pool, 'pdr_zero');
  assert.equal(li.import_id, firstImport, 'the latest import is the one that was marked');
  assert.equal(li.options.uploaded, true);
  assert.equal(li.options.auto_resync, false);
});

test('an uploaded import is not re-read by the weekly job, resync_import or the re-sync card', { skip }, async () => {
  const requests = gets;
  const logs: string[] = [];
  const out = await resyncAll({ pool, docs: new DocStore(), http: blocked }, (m) => logs.push(m));
  assert.deepEqual(out, [], 'both imports are uploaded now: the weekly job has nothing to do');
  assert.equal(gets, requests);

  const proposed: any[] = [];
  const tools = Object.fromEntries(buildImportListTools({
    pool, docs: new DocStore(), http: blocked, actions: { propose: async (a: any) => { proposed.push(a); return { id: 'x', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const r = await tools.resync_import.execute({ dataset: 'pdr_zero' }, ctx);
  assert.deepEqual(r, { error: 'resync_manual', details: 'imported from an uploaded page: upload the page again' });
  assert.equal(proposed.length, 0, 'no card');
  assert.equal((await tools.resync_import.execute({ dataset: 'no_such_set' }, ctx)).error, 'no_list_import', 'no_list_import comes first');

  await assert.rejects(() => importActionHandlers({ pool, docs: new DocStore(), http: blocked })[RESYNC_IMPORT_KIND]({ dataset: 'pdr_zero' }), /^Error: resync_manual: imported from an uploaded page/);
  const [li] = await listImports(pool, 'pdr_zero');
  await assert.rejects(() => resyncDataset({ pool, docs: new DocStore(), http: blocked }, li, 'test'), /resync_manual/);
  assert.equal(gets, requests, 'not one request');
});

test('an upload that is gone (a restart) fails with upload_expired, and the site is never asked', { skip }, async () => {
  const [li] = await listImports(pool, 'pdr_zero');
  const requests = gets;
  await assert.rejects(() => resyncDataset({ pool, docs: new DocStore(), http: blocked }, li, 'test', { fromUpload: true }), /^Error: upload_expired: the uploaded page is gone/);

  // The Apply of a card made from an upload: the payload is passed as it is, so the same check runs.
  const docs = new DocStore();
  const up: any = await uploadPage({ docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML }));
  const plan = buildPlan(docs.get(up.doc_id)!, args('pdr_card'), null);
  const payload = payloadOf(plan, 'pdr_card', undefined, { uploaded: true });
  assert.equal(payload.uploaded, true);
  await assert.rejects(() => importActionHandlers({ pool, docs: new DocStore(), http: blocked })[IMPORT_LIST_KIND](payload as any), /upload_expired/);
  assert.equal(await count('pdr_card'), 0, 'nothing was written');

  // A page that was fetched live (not uploaded) in the store is not the upload either.
  const fetchedDocs = new DocStore();
  await fetchDocument(PDR_URL, { docs: fetchedDocs, http: live });
  const afterFetch = gets;
  await assert.rejects(() => runImport({ pool, docs: fetchedDocs, http: blocked }, payload, 'test'), /upload_expired/);
  assert.equal(gets, afterFetch, 'and nothing was fetched to replace it');
  assert.ok(requests < afterFetch, 'the one live fetch above is the only request of this test');
});

test('an upload for another address or an unknown dataset is refused and nothing is stored', { skip }, async () => {
  const docs = new DocStore();
  const deps = { docs, imports: { pool, http: blocked } };
  const other: any = await uploadPage(deps, UploadPageBody.parse({ url: 'https://zakon.rada.gov.ua/laws/show/other/print', content: PDR_HTML, dataset: 'pdr_rules' }));
  assert.equal(other.error, 'url_mismatch');
  assert.match(other.details, /was imported from https:\/\/zakon\.rada\.gov\.ua\/laws\/show\/1306-2001-%D0%BF\/print, not from https:\/\/zakon\.rada\.gov\.ua\/laws\/show\/other\/print/);
  const none: any = await uploadPage(deps, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML, dataset: 'no_such_set' }));
  assert.equal(none.error, 'no_list_import');
  assert.equal(docs.size, 0, 'nothing is kept for a refused upload');
  const noDb: any = await uploadPage({ docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML, dataset: 'pdr_rules' }));
  assert.equal(noDb.error, 'not_available');
  assert.equal(docs.size, 0);
});

test('a failing run is answered as { error, details } with the class of the failure', { skip }, async () => {
  const docs = new DocStore();
  // The same address, but a page that holds no clause: the plan finds nothing to cut.
  const res: any = await uploadPage({ docs, imports: { pool, http: blocked } }, UploadPageBody.parse({ url: PDR_URL, content: '<html><body><p>Сторінку не знайдено</p></body></html>', dataset: 'pdr_rules' }));
  assert.equal(res.error, 'no_entries');
  assert.match(res.details, /^no_entries: /);
});

test('import_list marks the card of an uploaded page, and Apply keeps the import manual', { skip }, async () => {
  const docs = new DocStore();
  const up: any = await uploadPage({ docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML }));
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildImportListTools({
    pool, docs, http: blocked, actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-up', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const input = (doc_id: string, dataset: string) => tools.import_list.input.parse({ doc_id, dataset, mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'ПДР' });
  const r = await tools.import_list.execute(input(up.doc_id, 'pdr_up'), ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(proposed[0].payload.uploaded, true);

  const applied: any = await importActionHandlers({ pool, docs, http: blocked })[IMPORT_LIST_KIND](proposed[0].payload);
  assert.equal(applied.inserted, 8);
  const [li] = await listImports(pool, 'pdr_up');
  assert.equal(li.options.uploaded, true);
  assert.equal(li.options.auto_resync, false, 'Apply passes autoResync: true, an upload still is not re-synced by the job');

  // A page fetched live gives a card without the mark.
  const fetched = new DocStore();
  const f: any = await fetchDocument(PDR_URL, { docs: fetched, http: live });
  const liveTools = Object.fromEntries(buildImportListTools({
    pool, docs: fetched, http: live, actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-live', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const lr = await liveTools.import_list.execute(liveTools.import_list.input.parse({ doc_id: f.doc.id, dataset: 'pdr_live2', mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'ПДР' }), ctx);
  assert.equal(lr.ok, true, JSON.stringify(lr));
  assert.equal('uploaded' in proposed[1].payload, false);
});
