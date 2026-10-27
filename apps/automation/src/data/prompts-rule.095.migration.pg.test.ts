/**
 * Migration 095 (the prompts rule: a post needs the prompt text and the picture, spec 068 FR-009). Creates its own database next
 * to EDITOR_PG_TEST_URL (init.sql + every migration except 083 and 095), then checks: 095 is a no-op while 083 has not been
 * applied (the 083 migration test applies everything else first); after 083 it replaces the 083 rule, appends the one sentence
 * to the description and refreshes the stats; the catalog, `query_data` and the write path follow; a second apply changes
 * nothing; an owner's own rule or description wins; the down file restores the 083 state. Skipped unless EDITOR_PG_TEST_URL is
 * set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { DataStore } from './data-store';
import { buildCatalog } from './data-catalog';
import { queryDataset } from './data-query';
import { pgDbName, pgWithDb } from '../common/testing/pg-test-url';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');
const M083 = readFileSync(join(MIGRATIONS, '083_post_requires.sql'), 'utf8');
const M095 = readFileSync(join(MIGRATIONS, '095_prompts_post_requires.sql'), 'utf8');
const D095 = readFileSync(join(MIGRATIONS, 'down', '095_prompts_post_requires.down.sql'), 'utf8');
const RESOURCE = 'telegram:@pgt095_prompts';
const TODAY = { month: 10, day: 27 };
const RULE_083 = [['page_url'], ['prompt_text', 'media_url']];
const RULE_095 = [['prompt_text'], ['media_url']];
const NOTE = ' PromptHero rows have no prompt text and cannot be posted.';

let admin: Client;
let pool: Pool;
let dbName: string;

async function applyFile(sql: string) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const schema = async () => (await pool.query(`SELECT * FROM data_schemas WHERE key = 'prompts'`)).rows[0];
const migrationRecorded = async () => (await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '095_prompts_post_requires'`)).rows.length === 1;

const img = (i: number) => `https://cdn.prompthero.com/img${i}`;
const one = (i: number) => `https://prompthero.com/prompt/${i}abc-flux-portrait-${i}`;

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${pgDbName(url)}_m095_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new Client({ connectionString: pgWithDb(url, dbName) });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      if (f.startsWith('083') || f.startsWith('095')) continue;
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

test('without 083 (no post_requires column) 095 changes nothing and still records itself; 083 then sets its own rule', { skip }, async () => {
  assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'data_schemas' AND column_name = 'post_requires'`)).rows.length, 0);
  const before = (await schema()).description;
  await applyFile(M095);
  assert.equal((await schema()).description, before);
  assert.equal(await migrationRecorded(), true);
  await applyFile(M083);
  assert.deepEqual((await schema()).post_requires, RULE_083, '083 sets the rule it always did');
});

test('rows as the old rule left them: two PromptHero rows with a page and a picture pass it, a curated row without a picture too', { skip }, async () => {
  const store = new DataStore(pool);
  const res = await store.upsert('prompts', [
    { id: img(1), prompt_source: one(1), page_url: one(1), media_url: img(1), provider: 'prompthero', category: 'flux' },
    { id: img(2), prompt_source: one(2), page_url: one(2), media_url: img(2), provider: 'prompthero', category: 'flux' },
    { id: 'nb-1', prompt_source: 'https://m.example.com/1.png', page_url: 'https://github.com/x/y#1', provider: 'nanobanana', prompt_text: 'a cat, 8k', media_url: 'https://m.example.com/1.png' },
    { id: 'nb-2', prompt_source: 'https://m.example.com/2.png', page_url: 'https://github.com/x/y#2', provider: 'nanobanana', prompt_text: 'a dog' },
  ]);
  assert.equal(res.inserted, 4, JSON.stringify(res.invalid));
  const [e] = await buildCatalog(pool, { dataset: 'prompts', resource: RESOURCE, today: TODAY });
  assert.equal(e.not_postable ?? 0, 0);
  assert.equal(e.unposted_here, 4);
});

test('095 replaces the 083 rule, adds the sentence, keeps the version and the rows, and the stats follow', { skip }, async () => {
  const rows = (await pool.query(`SELECT id, data FROM data_items ORDER BY id`)).rows;
  const v = (await schema()).version;
  await applyFile(M095);
  const s = await schema();
  assert.deepEqual(s.post_requires, RULE_095);
  assert.ok(s.description.endsWith(NOTE), s.description);
  assert.match(s.description, /^Prompts for image and video generators\. PromptHero rows/);
  assert.equal(s.version, v, 'post_requires is not structural');
  assert.deepEqual((await pool.query(`SELECT id, data FROM data_items ORDER BY id`)).rows, rows, 'no row changes');
  const st = (await pool.query(`SELECT st.* FROM data_schema_stats st JOIN data_schemas s ON s.id = st.schema_id WHERE s.key = 'prompts'`)).rows[0];
  assert.equal(Number(st.rows_unpostable), 3, 'both PromptHero rows and the curated row without a picture');
  assert.equal(Number(st.unposted_network), 1);
});

test('the catalog, query_data and the write path follow the new rule', { skip }, async () => {
  const [e] = await buildCatalog(pool, { dataset: 'prompts', resource: RESOURCE, today: TODAY });
  assert.equal(e.not_postable, 3);
  assert.equal(e.unposted_here, 1, 'only the curated row with text and picture is left');
  assert.deepEqual(e.post_requires, ['prompt_text', 'media_url']);

  const s = (await new DataStore(pool).getSchema('prompts'))!;
  const agent = await queryDataset(pool, s, { audience: 'agent', fields: ['prompt_text', 'media_url'], limit: 20, today: TODAY, unpostedOn: RESOURCE, withTotal: true });
  assert.equal(agent.total, 1);
  assert.equal(agent.rows[0].prompt_text, 'a cat, 8k');

  // The review-4 case: a PromptHero row asked for by its ref comes back flagged, not hidden.
  const hero = (await pool.query(`SELECT d.id::text FROM data_items d WHERE d.data->>'id' = $1`, [img(1)])).rows[0].id;
  const byRef = await queryDataset(pool, s, { audience: 'agent', fields: ['page_url', 'prompt_text'], ids: [hero], limit: 1, today: TODAY, usedOn: RESOURCE });
  assert.equal(byRef.rows.length, 1);
  assert.deepEqual([byRef.rows[0].postable, byRef.rows[0].missing, byRef.rows[0].used_here], [false, ['prompt_text'], false]);

  const res = await new DataStore(pool).upsert('prompts', [
    { id: img(9), prompt_source: one(9), page_url: one(9), media_url: img(9), provider: 'prompthero' },
    { id: 'nb-9', prompt_source: 'https://m.example.com/9.png', page_url: 'https://github.com/x/y#9', provider: 'nanobanana', prompt_text: 'a fox', media_url: 'https://m.example.com/9.png' },
  ]);
  assert.equal(res.inserted, 1);
  assert.deepEqual(res.invalid.map((x) => [x.row, x.field, x.error]), [[0, 'prompt_text', 'required for posting: prompt_text']]);
});

test('a second apply changes nothing (the sentence is not added twice)', { skip }, async () => {
  const before = await schema();
  await applyFile(M095);
  const after = await schema();
  assert.equal(after.description, before.description);
  assert.deepEqual(after.post_requires, RULE_095);
  assert.equal(after.description.split(NOTE).length, 2);
});

test('down restores the 083 rule and the description; up again; an owner rule or description is left alone both ways', { skip }, async () => {
  await applyFile(D095);
  let s = await schema();
  assert.deepEqual(s.post_requires, RULE_083);
  assert.ok(!s.description.endsWith(NOTE));
  assert.match(s.description, /their prompt text is not stored\. Curated GitHub rows/);
  assert.equal(await migrationRecorded(), false);
  const st = (await pool.query(`SELECT st.* FROM data_schema_stats st JOIN data_schemas s ON s.id = st.schema_id WHERE s.key = 'prompts'`)).rows[0];
  assert.equal(Number(st.rows_unpostable), 0, 'the stats follow: under the 083 rule every row has a page and a text or a picture');

  await applyFile(M095);
  assert.deepEqual((await schema()).post_requires, RULE_095);

  // The owner's own rule and wording win in both directions.
  await pool.query(`UPDATE data_schemas SET post_requires = '[["page_url"]]'::jsonb, description = 'Owner wording.' WHERE key = 'prompts'`);
  await applyFile(M095);
  s = await schema();
  assert.deepEqual([s.post_requires, s.description], [[['page_url']], 'Owner wording.']);
  await applyFile(D095);
  s = await schema();
  assert.deepEqual([s.post_requires, s.description], [[['page_url']], 'Owner wording.']);
});
