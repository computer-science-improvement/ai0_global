/**
 * Spec 032 T2: the one-time move of the 12 content tables (migration 058) on production-shaped data.
 * Creates its own database next to EDITOR_PG_TEST_URL (init.sql + migrations before 058 + seed), applies
 * 058, and checks parity, ids, idempotency, rollback on a parity failure and every legacy write path
 * through the compatibility views. Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB).
 * Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { seedLegacyTables, SEEDED_TABLES } from './testing/legacy-seed';
import { RecipesRepository } from '../strategies/recipes/recipes.repository';
import { FactsRepository } from '../strategies/facts/facts.repository';
import { PromptsRepository } from '../strategies/ai0-prompts/prompts.repository';
import { CuratedPromptsRepository } from '../strategies/curated-prompts/curated-prompts.repository';
import { MotivationBiographyRepository } from '../strategies/motivation-biography/motivation-biography.repository';
import { checkQuizGroundTruth } from '../editor/post/quiz-ground-truth';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');
const M058 = readFileSync(join(MIGRATIONS, '058_data_store.sql'), 'utf8');
const N = 120;

let admin: Client;
let pool: Pool;
let dbName: string;
let dbUrl: string;
const snapshot: Record<string, any[]> = {};

function withDb(u: string, db: string): string {
  const x = new URL(u);
  x.pathname = '/' + db;
  return x.toString();
}

async function applyFile(c: Pick<Client, 'query'>, sql: string) {
  await c.query('BEGIN');
  try { await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
}

/** A fresh database with init.sql + migrations before `upto`, seeded with legacy rows. */
async function freshDb(name: string, upto = '058'): Promise<string> {
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const u = withDb(url!, name);
  const c = new Client({ connectionString: u });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      if (f >= upto) break;
      await applyFile(c, readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
    await seedLegacyTables(c, N);
  } finally {
    await c.end();
  }
  return u;
}

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${new URL(url).pathname.slice(1) || 'postgres'}_m058_${process.pid}`.toLowerCase();
  dbUrl = await freshDb(dbName);
  pool = new Pool({ connectionString: dbUrl, max: 4 });
  for (const t of SEEDED_TABLES) snapshot[t] = (await pool.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
  const c = await pool.connect();
  try { await applyFile(c, M058); } finally { c.release(); }
});

after(async () => {
  if (!url) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}_fail`).catch(() => undefined);
  await admin.end();
});

const norm = (r: any) => JSON.parse(JSON.stringify(r));

test('every table became a view; per-table counts and every row match the pre-move table field by field', { skip }, async () => {
  for (const t of SEEDED_TABLES) {
    const kind = (await pool.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`, [`public.${t}`])).rows[0].relkind;
    assert.equal(kind, 'v', `${t} is a view`);
    const now = (await pool.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
    assert.equal(now.length, N, `${t} count`);
    // Same column names in the same order.
    assert.deepEqual(Object.keys(now[0]), Object.keys(snapshot[t][0]), `${t} columns`);
    // 20 sampled rows equal field by field (the migration itself compares every row with EXCEPT ALL).
    for (let i = 0; i < 20; i++) {
      const k = Math.floor((i * N) / 20);
      assert.deepEqual(norm(now[k]), norm(snapshot[t][k]), `${t} row ${k}`);
    }
    const legacy = (await pool.query(`SELECT count(*)::int AS n FROM legacy_${t}`)).rows[0].n;
    assert.equal(legacy, N);
  }
});

test('old ids are stable through legacy_ref; schemas are seeded with descriptions and roles', { skip }, async () => {
  const r = snapshot.recipes[5];
  const item = (await pool.query(`SELECT * FROM data_items WHERE legacy_ref = $1`, [`library://recipes/${r.id}`])).rows[0];
  assert.ok(item);
  assert.equal(item.title, r.title_uk || r.title, 'title role: title_uk first, then title');
  assert.deepEqual(item.posted, r.posted);
  assert.equal(item.license, r.license);
  const s = (await pool.query(`SELECT * FROM data_schemas WHERE key = 'pdr_questions'`)).rows[0];
  assert.equal(s.entity, 'quiz_question');
  assert.deepEqual(s.dedup_key, ['question_id']);
  assert.deepEqual(s.legacy, { table: 'pdr_questions', id: 'uuid' });
  assert.match(s.fields.find((f: any) => f.name === 'correct_answer_num').description, /never correct it/);
  assert.ok(s.fields.every((f: any) => typeof f.description === 'string' && f.description.length > 5));
  const prompts = (await pool.query(`SELECT legacy FROM data_schemas WHERE key = 'prompts'`)).rows[0];
  assert.deepEqual(prompts.legacy, { table: 'prompts', id: 'text', id_field: 'id' });
  const stats = (await pool.query(`SELECT rows_total::int FROM data_schema_stats st JOIN data_schemas s ON s.id = st.schema_id WHERE s.key = 'facts'`)).rows[0];
  assert.equal(stats.rows_total, N);
  // Case-only dedup collisions survive with a suffix instead of failing parity.
  const coll = (await pool.query(`SELECT count(*)::int AS n FROM data_items WHERE external_key LIKE '%#%'`)).rows[0].n;
  assert.ok(coll >= 2);
});

test('re-running 058 is a no-op; init.sql still re-runs cleanly', { skip }, async () => {
  const c = await pool.connect();
  try {
    await applyFile(c, M058);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
  } finally { c.release(); }
  for (const t of ['recipes', 'name_days']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, N);
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_items`)).rows[0].n, N * SEEDED_TABLES.length);
});

test('legacy tables are read-only', { skip }, async () => {
  await assert.rejects(pool.query(`UPDATE legacy_facts SET category = 'x'`), /read-only/);
  await assert.rejects(pool.query(`DELETE FROM legacy_jokes`), /read-only/);
});

test('pipeline-style INSERT through a view: new rows inserted with RETURNING id, duplicates skipped', { skip }, async () => {
  const ins = await pool.query(
    `INSERT INTO pdr_questions (question_id, ticket_number, question_num, text, answers, correct_answer_num, explanation, source_name)
     VALUES (99001, 99, 1, 'Нове питання?', '["Так","Ні"]', 2, '', 'pgtest') RETURNING id, posted, created_at, license`);
  assert.equal(ins.rowCount, 1);
  assert.match(ins.rows[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(ins.rows[0].posted, {});
  assert.equal(ins.rows[0].license, 'unknown', 'view defaults mirror the old column defaults');
  const view = (await pool.query(`SELECT * FROM pdr_questions WHERE id = $1`, [ins.rows[0].id])).rows[0];
  assert.deepEqual(view.answers, ['Так', 'Ні']);
  assert.equal((await pool.query(`SELECT legacy_ref FROM data_items WHERE legacy_ref = $1`, [`library://pdr_questions/${ins.rows[0].id}`])).rowCount, 1);
  // Same dedup key again: skipped like ON CONFLICT DO NOTHING (an untargeted ON CONFLICT is accepted).
  const dup = await pool.query(
    `INSERT INTO pdr_questions (question_id, ticket_number, question_num, text, answers, correct_answer_num)
     VALUES (99001, 99, 1, 'Інший текст', '[]', 1) ON CONFLICT DO NOTHING`);
  assert.equal(dup.rowCount, 0);
  assert.equal(view.text, 'Нове питання?');
  // A text-id table keeps its id as data.
  const p = await pool.query(`INSERT INTO prompts (id, prompt_source, provider, prompt_text) VALUES ('curated-pg-1', 'https://x', 'nanobanana', 'a cat') RETURNING id`);
  assert.equal(p.rows[0].id, 'curated-pg-1');
  // NOT NULL semantics are kept: a missing required column fails loudly.
  await assert.rejects(pool.query(`INSERT INTO jokes (title) VALUES ('no content')`), /invalid row/);
  // The quiz guard reads the new row through the view.
  const guard = await checkQuizGroundTruth(pool, { format: 'quiz', library_ref: `library://pdr_questions/${ins.rows[0].id}`,
    poll: { question: 'q', options: ['Так', 'Ні'], correct_index: 1 } } as any);
  assert.equal(guard, null);
});

test('posted markers and markError go through the trigger (strategy repositories unchanged)', { skip }, async () => {
  const f = snapshot.facts.find((r) => Object.keys(r.posted).length === 0)!;
  await new FactsRepository(pool).markPosted(f.id, '@pg_chan');
  const after1 = (await pool.query(`SELECT posted FROM facts WHERE id = $1`, [f.id])).rows[0].posted;
  assert.ok(after1['@pg_chan']);
  const b = snapshot.birthdays[3];
  await new MotivationBiographyRepository(pool).markError(b.id, '@bio', 'no photo');
  const pb = (await pool.query(`SELECT posted FROM birthdays WHERE id = $1`, [b.id])).rows[0].posted;
  assert.equal(pb['error:@bio'].reason, 'no photo');
  const pr = snapshot.prompts[7];
  await new PromptsRepository(pool).markPosted(pr.id, 'TELEGRAM');
  await new CuratedPromptsRepository(pool).markError(pr.id);
  const prow = (await pool.query(`SELECT posted, status FROM prompts WHERE id = $1`, [pr.id])).rows[0];
  assert.ok(prow.posted.TELEGRAM);
  assert.equal(prow.status, 'ERROR', 'a data column update through the view');
  // Removing a key works too (the documented manual reset of an error marker).
  await pool.query(`UPDATE birthdays SET posted = posted - 'error:@bio' WHERE id = $1`, [b.id]);
  assert.equal((await pool.query(`SELECT posted ? 'error:@bio' AS has FROM birthdays WHERE id = $1`, [b.id])).rows[0].has, false);
});

test('two writers marking the same row concurrently do not lose a marker', { skip }, async () => {
  const q = snapshot.quotes[9];
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query('BEGIN');
    await c1.query(`UPDATE quotes SET posted = posted || jsonb_build_object('@one', now()) WHERE id = $1`, [q.id]);
    const second = c2.query(`UPDATE quotes SET posted = posted || jsonb_build_object('@two', now()) WHERE id = $1`, [q.id]);
    await new Promise((r) => setTimeout(r, 150));
    await c1.query('COMMIT');
    await second;
  } finally { c1.release(); c2.release(); }
  const p = (await pool.query(`SELECT posted FROM quotes WHERE id = $1`, [q.id])).rows[0].posted;
  assert.ok(p['@one'] && p['@two'], JSON.stringify(p));
});

test('recipe translation and telegraph_url updates go through the trigger; envelope follows', { skip }, async () => {
  const r = snapshot.recipes.find((x) => x.title_uk === null)!;
  await pool.query(
    `UPDATE recipes SET title_uk = $2, ingredients_uk = $3, instructions_uk = $4, translated_at = now() WHERE id = $1`,
    [r.id, 'Пиріг', '1 яйце', 'Спекти.']);
  await new RecipesRepository(pool).saveTelegraph(r.id, { url: 'https://telegra.ph/Pyrih-1', path: 'Pyrih-1' });
  await new RecipesRepository(pool).markPosted(r.id, 'TELEGRAM');
  const v = (await pool.query(`SELECT title_uk, ingredients_uk, telegraph_url, telegraph_path, translated_at, posted, kcal FROM recipes WHERE id = $1`, [r.id])).rows[0];
  assert.equal(v.title_uk, 'Пиріг');
  assert.equal(v.telegraph_url, 'https://telegra.ph/Pyrih-1');
  assert.ok(v.translated_at instanceof Date);
  assert.ok(v.posted.TELEGRAM);
  assert.equal(v.kcal, r.kcal, 'untouched columns keep their values');
  const env = (await pool.query(`SELECT title FROM data_items WHERE legacy_ref = $1`, [`library://recipes/${r.id}`])).rows[0];
  assert.equal(env.title, 'Пиріг', 'the envelope title follows title_uk');
  // Clearing a nullable column through the view removes the field.
  await pool.query(`UPDATE recipes SET telegraph_path = NULL WHERE id = $1`, [r.id]);
  assert.equal((await pool.query(`SELECT telegraph_path FROM recipes WHERE id = $1`, [r.id])).rows[0].telegraph_path, null);
  // A required column cannot be nulled; ids cannot change.
  await assert.rejects(pool.query(`UPDATE recipes SET title = NULL WHERE id = $1`, [r.id]), /invalid update/);
  await assert.rejects(pool.query(`UPDATE recipes SET id = gen_random_uuid() WHERE id = $1`, [r.id]), /id cannot change/);
});

test('DELETE through a view removes the store row (eval seed cleanup path)', { skip }, async () => {
  const del = await pool.query(`DELETE FROM pdr_questions WHERE source_name = 'pgtest'`);
  assert.equal(del.rowCount, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_items WHERE data->>'question_id' = '99001'`)).rows[0].n, 0);
});

test('editor_ro can read the views and the store', { skip }, async () => {
  const has = (await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro'`)).rowCount;
  if (!has) return;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE editor_ro');
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM recipes`)).rows[0].n > 0, true);
    await c.query(`SELECT key FROM data_schemas LIMIT 1`);
    await c.query(`SELECT id FROM data_items LIMIT 1`);
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

test('a parity failure rolls the whole migration back', { skip }, async () => {
  const u = await freshDb(`${dbName}_fail`);
  const c = new Client({ connectionString: u });
  await c.connect();
  try {
    // Sabotage: data_items silently drops one quote, so counts cannot match.
    const sabotaged = M058.replace(
      'DO $move$',
      `CREATE OR REPLACE FUNCTION pg_sabotage() RETURNS trigger LANGUAGE plpgsql AS $s$
         BEGIN IF NEW.data->>'text_hash' IS NOT NULL AND NEW.legacy_ref LIKE 'library://quotes/%' AND NEW.data->>'text' LIKE 'Цитата 7 %' THEN RETURN NULL; END IF; RETURN NEW; END $s$;
       CREATE TRIGGER pg_sabotage BEFORE INSERT ON data_items FOR EACH ROW EXECUTE FUNCTION pg_sabotage();
       DO $move$`);
    await assert.rejects(applyFile(c, sabotaged), /058 parity: quotes has 120 rows but data_items got 119/);
    const kinds = (await c.query(`SELECT relname, relkind FROM pg_class WHERE relname IN ('recipes','quotes','legacy_recipes') ORDER BY relname`)).rows;
    assert.deepEqual(kinds.map((k) => `${k.relname}:${k.relkind}`), ['quotes:r', 'recipes:r'], 'nothing moved, nothing renamed');
    assert.equal((await c.query(`SELECT to_regclass('public.data_items') AS t`)).rows[0].t, null, 'even the store tables rolled back');
  } finally {
    await c.end();
  }
});
