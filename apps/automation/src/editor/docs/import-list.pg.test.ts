/**
 * Spec 065 T3 on a real database: the Apply of an import card creates the dataset (post_requires, stable dedup key) and
 * writes the rows of the trimmed nanobanana README as one undoable import; a second read of the same page changes
 * nothing and leaves no import row; a new entry on the page is the only thing the next re-sync adds; undo removes it.
 * The page comes from an injected getter — no network. Creates its own database next to EDITOR_PG_TEST_URL (init.sql +
 * every migration) and drops it. Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { DataImportService } from '../../data/import/data-import.service';
import { pgDbName, pgWithDb } from '../../common/testing/pg-test-url';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { buildPlan, IMPORT_LIST_KIND, ImportListInput, listImports, payloadOf, RESYNC_IMPORT_KIND, runImport } from './import-list';
import { buildImportListTools, importActionHandlers } from './import-list-tools';
import { resyncAll } from './list-resync.worker';
import { NANOBANANA_README, NANOBANANA_URL } from './testing/nanobanana-fixture';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');
const DATASET = 'nb_pg065';
const FENCE = '```';

let admin: Client;
let pool: Pool;
let dbName: string;

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
let page = NANOBANANA_README;
const http = { lookup, get: async () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, data: page }) };

const NEW_ENTRY = [
  '### 2.3. A Brand New Entry', '*Added after the first import.*', '',
  '<img src="https://github.com/user-attachments/assets/new-entry-1" width="300">', '',
  '**Prompt:**', FENCE + 'text', 'A lighthouse in a storm, oil painting.', FENCE, '',
  '**Source:** [@newguy](https://x.com/newguy) - [Post](https://x.com/newguy/status/1)', '', '',
].join('\n');
const withNewEntry = () => NANOBANANA_README.replace('## 3. Resources', `${NEW_ENTRY}## 3. Resources`);

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${pgDbName(url)}_i065_${process.pid}`.toLowerCase();
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

const MAPPING = { title: 'heading', prompt_text: 'first_code_block', media_url: 'last_image', author: 'link_text_after:Source', source_url: 'last_link_after:Source' };

async function cardPayload(docs: DocStore) {
  const r: any = await fetchDocument(NANOBANANA_URL, { docs, http });
  const plan = buildPlan(r.doc, { dataset: DATASET, mapping: MAPPING, license: 'CC BY 4.0', filter: { has_code_block: true }, title: 'Nano Banana prompts' }, null);
  return payloadOf(plan, DATASET);
}

const rows = async () =>
  (await pool.query(
    `SELECT d.data, data_postable(s.post_requires, d.data) AS postable, d.status FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
      WHERE s.key = $1 ORDER BY d.data->>'list_ref'`, [DATASET])).rows;

const docs = new DocStore();
let firstImport: string;

test('Apply creates the dataset and imports the four complete entries; all of them are postable', { skip }, async () => {
  const payload = await cardPayload(docs);
  assert.equal(payload.expected, 4);
  const handlers = importActionHandlers({ pool, docs, http });
  const res: any = await handlers[IMPORT_LIST_KIND](payload as any);
  assert.equal(res.created_dataset, true);
  assert.equal(res.inserted, 4);
  assert.equal(res.not_postable, 1, 'the entry without a picture is left out');
  assert.ok(res.import_id);
  firstImport = res.import_id;

  const schema = (await pool.query(`SELECT post_requires, dedup_key, default_license FROM data_schemas WHERE key = $1`, [DATASET])).rows[0];
  assert.deepEqual(schema.post_requires, [['title'], ['prompt_text'], ['media_url']]);
  assert.deepEqual(schema.dedup_key, ['list_ref']);
  assert.equal(schema.default_license, 'CC BY 4.0');

  const all = await rows();
  assert.equal(all.length, 4);
  assert.ok(all.every((r) => r.postable === true && r.status === 'active'));
  const wrinkles = all.find((r) => r.data.title === 'Ironing Out Wrinkles')!;
  assert.equal(wrinkles.data.media_url, 'https://github.com/user-attachments/assets/793ad242-7867-4709-bdc6-55021f5eb78f');
  assert.equal(wrinkles.data.author, '@emollick');
  assert.equal(wrinkles.data.license, 'CC BY 4.0');
  assert.match(all.find((r) => r.data.title === 'Hyper-Realistic Crowd Composition')!.data.prompt_text, /\n\nGENERAL STYLE/, 'the prompt keeps its line breaks');
  assert.match(all.find((r) => r.data.title === '2000s Mirror Selfie')!.data.prompt_text, /"flash": true/);

  // The import row carries what a re-sync needs.
  const [li] = await listImports(pool, DATASET);
  assert.equal(li.import_id, firstImport);
  assert.equal(li.options.url, NANOBANANA_URL);
  assert.equal(li.options.auto_resync, true);
  assert.equal(li.options.level, 3);
});

test('reading the same page again changes nothing and leaves no import row behind', { skip }, async () => {
  const before = (await pool.query(`SELECT count(*)::int AS n FROM data_imports`)).rows[0].n;
  const handlers = importActionHandlers({ pool, docs, http });
  const res: any = await handlers[RESYNC_IMPORT_KIND]({ dataset: DATASET });
  assert.equal(res.inserted, 0);
  assert.equal(res.updated, 0);
  assert.equal(res.import_id, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_imports`)).rows[0].n, before);
  assert.equal((await rows()).length, 4);
});

test('resync_import runs silently after the first Apply and adds only the new entry', { skip }, async () => {
  page = withNewEntry();
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildImportListTools({ pool, docs, http, actions: { propose: async (a: any) => { proposed.push(a); return { id: 'x', ...a }; } } as any }).map((t) => [t.name, t])) as Record<string, any>;
  const r = await tools.resync_import.execute({ dataset: DATASET }, { runId: 'r', role: 'composer', channelKey: null, extras: {} });
  assert.equal(r.ok, true);
  assert.equal(r.silent, true);
  assert.equal(r.inserted, 1);
  assert.equal(r.updated, 0);
  assert.equal(proposed.length, 0, 'no card');
  const all = await rows();
  assert.equal(all.length, 5);
  const added = all.find((x) => x.data.title === 'A Brand New Entry')!;
  assert.equal(added.postable, true);
  assert.equal(added.data.author, '@newguy');
  assert.equal(added.data.source_url, 'https://x.com/newguy/status/1');
  assert.equal(added.data.license, 'CC BY 4.0');
  // The newest list import is the re-sync (so the next one starts from it).
  const [li] = await listImports(pool, DATASET);
  assert.notEqual(li.import_id, firstImport);
  assert.equal(li.options.auto_resync, true);
});

test('with IMPORT_RESYNC_AUTO off the tool asks with a card instead', { skip }, async () => {
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildImportListTools({
    pool, docs, http, env: (k) => (k === 'IMPORT_RESYNC_AUTO' ? 'false' : undefined),
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const r = await tools.resync_import.execute({ dataset: DATASET }, { runId: 'r', role: 'composer', channelKey: null, extras: {} });
  assert.equal(r.pending_action, 'pa-1');
  assert.equal(proposed[0].kind, RESYNC_IMPORT_KIND);
  assert.deepEqual(proposed[0].payload.dataset, DATASET);
  assert.equal((await tools.resync_import.execute({ dataset: 'no_such_set' }, { runId: 'r', role: 'composer', channelKey: null, extras: {} })).error, 'no_list_import');
});

test('the weekly job re-reads every auto list and survives a page that fails', { skip }, async () => {
  const logs: string[] = [];
  const quiet = await resyncAll({ pool, docs, http }, (m) => logs.push(m));
  assert.deepEqual(quiet, [{ dataset: DATASET, inserted: 0, updated: 0 }], 'nothing new');
  page = withNewEntry().replace('## 3. Resources', `### 2.4. Another One\n\n${FENCE}text\nA second new prompt.\n${FENCE}\n\n<img src="https://github.com/user-attachments/assets/new-entry-2">\n\n## 3. Resources`);
  const out = await resyncAll({ pool, docs, http }, (m) => logs.push(m));
  assert.equal(out[0].inserted, 1);
  assert.ok(logs.some((l) => /list re-sync nb_pg065: 1 new/.test(l)));
  const failing = { ...http, get: async () => ({ status: 500, headers: {}, data: 'boom' }) };
  const bad = await resyncAll({ pool, docs: new DocStore(), http: failing as any }, (m) => logs.push(m));
  assert.equal(bad.length, 1);
  assert.ok(bad[0].error, 'the failure is reported, not thrown');
  assert.equal((await rows()).length, 6);
});

test('undo of an import removes exactly its rows', { skip }, async () => {
  const [li] = await listImports(pool, DATASET);
  const res = await new DataImportService(pool).undo(li.import_id, 'test');
  assert.ok(res.deleted + res.hidden >= 1);
  const left = await rows();
  assert.ok(left.length < 6, 'the last re-sync is gone');
  assert.ok(left.some((x) => x.data.title === 'Hyper-Realistic Crowd Composition'), 'the first import stays');
  // Undoing the Apply that created the dataset empties it.
  await new DataImportService(pool).undo(firstImport, 'test');
  const active = (await rows()).filter((x) => x.status === 'active');
  assert.ok(active.every((x) => x.data.title !== 'Hyper-Realistic Crowd Composition'));
});

test('runImport refuses a dataset that is gone and carries no schema to create', { skip }, async () => {
  const payload: any = { ...(await cardPayload(docs)), dataset: 'never_created', new_schema: null };
  await assert.rejects(runImport({ pool, docs, http }, payload, 'test'), /no longer exists/);
});

test('the card schema parses through the tool input too', { skip }, () => {
  assert.doesNotThrow(() => ImportListInput.parse({ doc_id: 'doc_1234567890', dataset: DATASET, mapping: MAPPING }));
});
