/**
 * Migration 083 (post_requires) on a database shaped like production on 2026-10-18: PromptHero rows of
 * `prompts` loaded by the old pipeline mapping (gallery page in page_url, the single-prompt link only in
 * prompt_source, the image only in id). Creates its own database next to EDITOR_PG_TEST_URL (init.sql +
 * every other migration, 084+ included), applies 083 twice, and checks the repair, the undo, the catalog numbers, the
 * agents' row picking, the stats and the write path. Skipped unless EDITOR_PG_TEST_URL is set (needs
 * CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { DataStore } from './data-store';
import { buildCatalog, summarize } from './data-catalog';
import { queryDataset } from './data-query';
import { DataImportService } from './import/data-import.service';
import { pgDbName, pgWithDb } from '../common/testing/pg-test-url';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');
const M083 = readFileSync(join(MIGRATIONS, '083_post_requires.sql'), 'utf8');
const RESOURCE = 'telegram:@pgt083_prompts';
const TODAY = { month: 10, day: 18 };

let admin: Client;
let pool: Pool;
let dbName: string;

async function applyFile(c: Pick<Client, 'query'>, sql: string) {
  await c.query('BEGIN');
  try { await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
}

const img = (i: number) => `https://cdn.prompthero.com/img${i}`;
const one = (i: number) => `https://prompthero.com/prompt/${i}abc-flux-portrait-${i}`;

/** Rows as the old loader wrote them, plus the shapes the owner's data has around them. */
const SEED = [
  // 0–3: old loader output — gallery page_url, the real link in prompt_source, the image only in id.
  ...[0, 1, 2, 3].map((i) => ({ id: img(i), prompt_source: one(i), page_url: 'https://prompthero.com/flux-prompts', provider: 'prompthero', category: 'flux' })),
  // 4: gallery page_url and a gallery prompt_source: nothing to repair it from → page_url cleared, not postable.
  { id: img(4), prompt_source: 'https://prompthero.com/interior-design-prompts', page_url: 'https://prompthero.com/interior-design-prompts', provider: 'prompthero', category: 'interior-design' },
  // 5: an older row with the right page_url and no media (already posted on the channel).
  { id: img(5), prompt_source: one(5), page_url: one(5), provider: 'prompthero', category: 'anime' },
  // 6: a curated GitHub row: full text, page on GitHub — untouched.
  { id: 'nb-6', prompt_source: 'https://m.example.com/6.png', page_url: 'https://github.com/x/y#6', provider: 'nanobanana', title: 'Cat', prompt_text: 'a cat, 8k', media_url: 'https://m.example.com/6.png', media_type: 'image' },
  // 7: a curated row without a page: not postable (page_url is required), nothing to repair.
  { id: 'nb-7', prompt_source: 'https://m.example.com/7.png', provider: 'nanobanana', prompt_text: 'a dog' },
];

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${pgDbName(url)}_m083_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new Client({ connectionString: pgWithDb(url, dbName) });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      if (f.startsWith('083')) continue; // later migrations (084+) are already in place when 083 lands
      await applyFile(c, readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
    // The pre-083 write path accepts these rows (that is the bug).
    const r = (await c.query(`SELECT data_items_upsert('prompts', $1::jsonb) AS r`, [JSON.stringify(SEED)])).rows[0].r;
    assert.equal(r.inserted, SEED.length, JSON.stringify(r.invalid));
    // Row 5 was posted on the resource.
    await c.query(
      `INSERT INTO content_ledger (source_ref, resource_ref, origin, status, used_at)
       SELECT 'data://prompts/' || d.id, $2, 'editor', 'published', now() FROM data_items d WHERE d.external_key = lower($1)`, [img(5), RESOURCE]);
    await c.query(`SELECT data_schema_stats_refresh()`);
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

const rowOf = async (id: string) =>
  (await pool.query(`SELECT d.* FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = 'prompts' AND d.external_key = lower($1)`, [id])).rows[0];

/** Every prompts row's data before 083, by external key. */
const pre = new Map<string, Record<string, unknown>>();

test('before 083 every unused row counts as material, the broken ones included (the reported symptom)', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT d.external_key, d.data,
            NOT EXISTS (SELECT 1 FROM content_ledger l WHERE l.resource_ref = $1 AND l.source_ref = 'data://prompts/' || d.id) AS unused
       FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = 'prompts' AND d.status = 'active'`, [RESOURCE]);
  for (const r of rows) pre.set(r.external_key, r.data);
  assert.equal(rows.length, SEED.length);
  assert.equal(rows.filter((r) => r.unused).length, SEED.length - 1);
  assert.equal(rows.filter((r) => r.data.provider === 'prompthero' && !r.data.media_url).length, 6, 'no PromptHero row has media');
});

test('083 repairs PromptHero rows from their own fields, clears gallery links it cannot replace, leaves the rest', { skip }, async () => {
  const c = await pool.connect();
  try { await applyFile(c, M083); } finally { c.release(); }

  const s = (await pool.query(`SELECT * FROM data_schemas WHERE key = 'prompts'`)).rows[0];
  assert.deepEqual(s.post_requires, [['page_url'], ['prompt_text', 'media_url']]);
  assert.match(s.description, /prompt text is not stored/);
  assert.match(s.fields.find((f: any) => f.name === 'page_url').description, /never a gallery page/);
  assert.equal(s.version, 1, 'description edits and post_requires keep the schema version');

  for (const i of [0, 1, 2, 3]) {
    const r = await rowOf(img(i));
    assert.equal(r.data.page_url, one(i), `row ${i} page_url`);
    assert.equal(r.data.media_url, img(i), `row ${i} media_url`);
    assert.equal(r.data.media_type, 'image');
    assert.equal(r.url, one(i), 'the url envelope follows');
    assert.equal(r.image_url, img(i), 'the image envelope follows');
  }
  const gallery = await rowOf(img(4));
  assert.equal(gallery.data.page_url, undefined, 'a gallery page_url with nothing to replace it is cleared');
  assert.equal(gallery.data.media_url, img(4));
  const posted = await rowOf(img(5));
  assert.equal(posted.data.page_url, one(5));
  assert.equal(posted.data.media_url, img(5), 'missing media is filled from id');
  const curated = await rowOf('nb-6');
  assert.deepEqual(curated.data, pre.get('nb-6'), 'curated rows are untouched');

  const imp = (await pool.query(`SELECT * FROM data_imports WHERE created_by = 'migration:083'`)).rows;
  assert.equal(imp.length, 1);
  assert.equal(imp[0].status, 'committed');
  assert.equal(imp[0].updated, 6);
  const snaps = (await pool.query(`SELECT count(*)::int AS n FROM data_import_snapshots WHERE import_id = $1`, [imp[0].id])).rows[0].n;
  assert.equal(snaps, 6, 'every changed row is snapshotted for undo');
});

test('re-applying 083 changes nothing (idempotent)', { skip }, async () => {
  const before = (await pool.query(`SELECT id, data FROM data_items ORDER BY id`)).rows;
  const c = await pool.connect();
  try { await applyFile(c, M083); } finally { c.release(); }
  assert.deepEqual((await pool.query(`SELECT id, data FROM data_items ORDER BY id`)).rows, before);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_imports WHERE created_by = 'migration:083'`)).rows[0].n, 1);
});

test('catalog: rows that miss post_requires are not_postable and never counted as unposted', { skip }, async () => {
  const [e] = await buildCatalog(pool, { dataset: 'prompts', resource: RESOURCE, today: TODAY });
  assert.equal(e.rows, 8);
  assert.equal(e.not_postable, 2, 'the cleared gallery row and the curated row without a page');
  assert.equal(e.unposted_here, 5, '8 rows − 2 not postable − 1 already posted here');
  assert.deepEqual(e.post_requires, ['page_url', 'prompt_text or media_url']);
  assert.equal(summarize(e).not_postable, 2);
  const st = (await pool.query(`SELECT st.* FROM data_schema_stats st JOIN data_schemas s ON s.id = st.schema_id WHERE s.key = 'prompts'`)).rows[0];
  assert.equal(Number(st.rows_unpostable), 2);
  assert.equal(Number(st.unposted_network), 5);
});

test('query_data (agents) never returns a row that misses post_requires; the owner still sees it', { skip }, async () => {
  const schema = (await new DataStore(pool).getSchema('prompts'))!;
  const agent = await queryDataset(pool, schema, { audience: 'agent', fields: ['page_url', 'media_url', 'prompt_text'], limit: 20, today: TODAY, unpostedOn: RESOURCE, withTotal: true });
  assert.equal(agent.total, 5);
  for (const r of agent.rows) assert.ok(r.page_url && (r.media_url || r.prompt_text), JSON.stringify(r));
  const owner = await queryDataset(pool, schema, { audience: 'owner', limit: 50, today: TODAY, withTotal: true });
  assert.equal(owner.total, 8);
});

test('the write path refuses a new row that misses post_requires; the import dry run reports it', { skip }, async () => {
  const store = new DataStore(pool);
  const res = await store.upsert('prompts', [
    { id: img(10), prompt_source: one(10), provider: 'prompthero' },
    { id: img(11), prompt_source: one(11), page_url: one(11), provider: 'prompthero' },
    { id: img(12), prompt_source: one(12), page_url: one(12), media_url: img(12), provider: 'prompthero' },
  ]);
  assert.equal(res.inserted, 1);
  assert.equal(res.invalid_rows, 2);
  assert.deepEqual(res.invalid.map((e) => [e.row, e.field, e.error]), [
    [0, 'page_url', 'required for posting: page_url; prompt_text or media_url'],
    [1, 'prompt_text', 'required for posting: prompt_text or media_url'],
  ]);
  // A merge into an existing row is not blocked (the catalog skips the row instead).
  const merge = await store.callUpsert('prompts', [{ id: img(12), media_url: null }], { updateFields: ['media_url'] });
  assert.equal(merge.updated, 1);

  const dry = await new DataImportService(pool).importRows('prompts', [
    { id: img(20), prompt_source: one(20), provider: 'prompthero', page_url: one(20) },
    { id: img(21), prompt_source: one(21), provider: 'prompthero', page_url: one(21), media_url: img(21) },
  ], { dryRun: true, createdBy: 'pgtest' });
  assert.equal(dry.invalid, 1);
  assert.equal(dry.new, 1);
  assert.match(dry.errors[0].error, /required for posting: prompt_text or media_url/);
});

test('post_requires is validated: unknown fields are refused by the API and by the database', { skip }, async () => {
  const store = new DataStore(pool);
  await assert.rejects(store.updateSchema('prompts', { post_requires: [['nope']] }, { changedBy: 'pgtest' }), /unknown field nope/);
  await assert.rejects(pool.query(`UPDATE data_schemas SET post_requires = '[["nope"]]' WHERE key = 'prompts'`), /data_schemas_post_requires_check/);
  await assert.rejects(pool.query(`UPDATE data_schemas SET post_requires = '[[]]' WHERE key = 'prompts'`), /data_schemas_post_requires_check/);
});

test('undo of the 083 repair restores the old values', { skip }, async () => {
  const imp = (await pool.query(`SELECT id FROM data_imports WHERE created_by = 'migration:083'`)).rows[0];
  const r = await new DataImportService(pool).undo(imp.id, 'pgtest');
  assert.equal(r.restored, 6);
  assert.deepEqual((await rowOf(img(0))).data, pre.get(img(0)));
  assert.deepEqual((await rowOf(img(4))).data, pre.get(img(4)));
});

test('083 is recorded in schema_migrations; its down file restores the 058/060 functions and drops the rule', { skip }, async () => {
  const rec = () => pool.query(`SELECT 1 FROM schema_migrations WHERE version = '083_post_requires'`);
  assert.equal((await rec()).rowCount, 1);

  const down = readFileSync(join(MIGRATIONS, 'down', '083_post_requires.down.sql'), 'utf8');
  const c = await pool.connect();
  try { await applyFile(c, down); } finally { c.release(); }
  assert.equal((await rec()).rowCount, 0);
  const cols = (await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'data_schemas' AND column_name = 'post_requires') OR (table_name = 'data_schema_stats' AND column_name = 'rows_unpostable')`)).rows;
  assert.deepEqual(cols, []);
  assert.equal((await pool.query(`SELECT 1 FROM pg_proc WHERE proname IN ('data_postable', 'data_post_missing', 'data_value_present')`)).rowCount, 0);
  // The pre-083 write path is back: a row nothing can be posted from is accepted again, and stats refresh runs.
  const res = (await pool.query(`SELECT data_items_upsert('prompts', $1::jsonb) AS r`,
    [JSON.stringify([{ id: img(30), prompt_source: one(30), provider: 'prompthero' }])])).rows[0].r;
  assert.equal(res.inserted, 1);
  await pool.query(`SELECT data_schema_stats_refresh()`);

  // 083 applies again on top of the reverted schema.
  const c2 = await pool.connect();
  try { await applyFile(c2, M083); } finally { c2.release(); }
  assert.equal((await rec()).rowCount, 1);
  const s = (await pool.query(`SELECT post_requires FROM data_schemas WHERE key = 'prompts'`)).rows[0];
  assert.deepEqual(s.post_requires, [['page_url'], ['prompt_text', 'media_url']]);
});
