/**
 * Spec 032 T6 against a throwaway Postgres with every migration applied: library_catalog and query_data on
 * real rows, data:// ⇄ library:// dedup in the publish guards, the PDR answer key through a data:// ref,
 * the owner's Apply of an agent's description fix, and the nightly stats job.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DataStore } from '../../data/data-store';
import { DataStatsCron } from '../../data/data-stats.cron';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { checkQuizGroundTruth } from '../post/quiz-ground-truth';
import { makeSpec } from '../post/testing/fixtures';
import { applyDataSchemaSuggestion, buildDataTools, QueryDataInput } from './data-tools';
import type { ToolContext } from '../harness/tool';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K = 'pgt032t_quotes';
const CH = '@pgt032t_chan';
const MARK = 'pgt032t-fixture';
let pool: Pool;
let store: DataStore;
const ids: string[] = [];
let pdrRef = '';
let pdrDataRef = '';

async function cleanup() {
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM pending_actions WHERE kind = 'edit_data_schema' AND payload->>'dataset' = $1`, [K]);
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032t\\_%')`);
  await pool.query(`DELETE FROM data_imports WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032t\\_%')`);
  await pool.query(`DELETE FROM data_schemas WHERE key LIKE 'pgt032t\\_%'`);
  await pool.query(`DELETE FROM data_items WHERE data->>'source_name' = $1`, [MARK]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  store = new DataStore(pool);
  await cleanup();
  await store.createSchema({
    key: K, title: 'Test quotes', description: 'Short quotes by Ukrainian writers', entity: 'quote',
    fields: [
      { name: 'text', type: 'long_text', description: 'The quote', required: true },
      { name: 'author', type: 'text', description: 'Who said it', filterable: true, searchable: true },
      { name: 'topic', type: 'enum', description: 'Theme', enum: ['love', 'freedom'], filterable: true },
      { name: 'internal_note', type: 'text', description: 'Editor note', agent_visible: false },
    ],
    roles: { title: 'author', body: 'text', category: 'topic' }, dedup_key: ['text'], language: 'uk', default_license: 'public_domain',
    reuse_policy: { kind: 'never' }, suitable_for: 'literature channels', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  await store.upsert(K, [
    { text: 'Борітеся — поборете!', author: 'Тарас Шевченко', topic: 'freedom', internal_note: 'classic' },
    { text: 'Contra spem spero', author: 'Леся Українка', topic: 'freedom' },
    { text: 'Любіть Україну', author: 'Володимир Сосюра', topic: 'love' },
  ]);
  const { rows } = await pool.query(`SELECT d.id::text FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 ORDER BY d.id`, [K]);
  ids.push(...rows.map((r) => r.id));
  await pool.query(`UPDATE data_items SET legacy_ref = $2 WHERE id = $1::bigint`, [ids[0], 'library://pgt_old_quotes/1']);
  await store.refreshStats(K);

  const uuid = randomUUID();
  pdrRef = `library://pdr_questions/${uuid}`;
  const res = await store.upsert('pdr_questions', [{
    question_id: 990000 + Math.floor(Math.random() * 9999), ticket_number: 99, question_num: 1, text: 'Швидкість у місті?',
    answers: ['40', '50', '60'], correct_answer_num: 2, explanation: 'п. 12.4', source_name: MARK, _legacy_ref: pdrRef,
  }]);
  assert.equal(res.inserted, 1, JSON.stringify(res));
  const { rows: p } = await pool.query(`SELECT id::text FROM data_items WHERE legacy_ref = $1`, [pdrRef]);
  pdrDataRef = `data://pdr_questions/${p[0].id}`;
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: CH };
const tools = () => Object.fromEntries(buildDataTools({ pool, today: () => ({ month: 3, day: 9 }) }).map((t) => [t.name, t]));

test('library_catalog describes the dataset from its schema and live numbers', { skip }, async () => {
  const r: any = await tools().library_catalog.execute({ dataset: K }, ctx);
  const d = r.dataset;
  assert.equal(d.title, 'Test quotes');
  assert.equal(d.description, 'Short quotes by Ukrainian writers');
  assert.deepEqual(d.fields.map((f: any) => f.name), ['text', 'author', 'topic']);
  assert.equal(d.rows, 3);
  assert.equal(d.unposted_here, 3);
  assert.equal(d.unposted_network, 3);
  assert.deepEqual(d.top_categories, [{ category: 'freedom', rows: 2 }, { category: 'love', rows: 1 }]);
  assert.equal(d.fields.find((f: any) => f.name === 'author').fill_pct, 100);
  const all: any = await tools().library_catalog.execute({}, ctx);
  assert.ok(all.datasets.some((x: any) => x.dataset === 'recipes'), 'the moved legacy datasets are in the catalog');

  await pool.query(`INSERT INTO published_posts (channel_id, message_id, source_url) VALUES ($1, 1, 'library://pgt_old_quotes/1')`, [CH]);
  assert.equal((await tools().library_catalog.execute({ dataset: K }, ctx) as any).dataset.unposted_here, 2, 'the legacy alias counts as used');
});

test('query_data on real rows: requested fields only, filters, used rows skipped', { skip }, async () => {
  const r: any = await tools().query_data.execute(QueryDataInput.parse({ schema: K, fields: ['author'], filters: [{ field: 'topic', op: 'eq', value: 'freedom' }], order: 'oldest' }), ctx);
  assert.deepEqual(r.rows, [{ ref: `data://${K}/${ids[1]}`, author: 'Леся Українка' }], 'Шевченко is used on this channel through its legacy ref');
  const hidden: any = await tools().query_data.execute(QueryDataInput.parse({ schema: K, fields: ['internal_note'] }), ctx);
  assert.equal(hidden.error, 'field_not_visible');
});

test('publish dedup: a data:// ref and its library:// alias are the same row', { skip }, async () => {
  const plans = new EditorPlansRepository(pool);
  assert.equal(await plans.sourceAlreadyPosted(CH, `data://${K}/${ids[0]}`), true, 'published as library://, asked as data://');
  assert.equal(await plans.sourceAlreadyPosted(CH, `data://${K}/${ids[1]}`), false);
  await pool.query(`INSERT INTO published_posts (channel_id, message_id, source_url, posted_at) VALUES ($1, 2, $2, now())`, [CH, `data://${K}/${ids[1]}`]);
  assert.equal(await plans.sourcePostedSince(CH, `data://${K}/${ids[1]}`, new Date(Date.now() - 3600_000)), true);
  assert.equal(await plans.sourceAlreadyPosted(CH, 'library://pgt_old_quotes/1'), true);
  assert.equal(await plans.sourceAlreadyPosted(CH, 'https://example.com/not-a-content-ref'), false);
});

test('the PDR answer key is checked through a data:// ref too', { skip }, async () => {
  const quiz = (ref: string, correct: number) => makeSpec({ format: 'quiz', media: [], body: [], hashtags: [], origin: 'library', source: undefined, library_ref: ref, poll: { question: 'Q?', options: ['40', '50', '60'], correct_index: correct } });
  assert.equal(await checkQuizGroundTruth(pool, quiz(pdrDataRef, 1)), null);
  assert.equal((await checkQuizGroundTruth(pool, quiz(pdrDataRef, 0)))?.error, 'quiz_answer_mismatch');
  assert.equal((await checkQuizGroundTruth(pool, quiz(pdrRef, 0)))?.error, 'quiz_answer_mismatch');
});

test('the owner applies a description fix without a version bump', { skip }, async () => {
  const before = await store.requireSchema(K);
  const r = await applyDataSchemaSuggestion(store, { dataset: K, target: 'field', field: 'author', old_text: 'Who said it', new_text: 'Author of the quote; Ukrainian writers only', evidence: 'All three rows are by Ukrainian writers.' });
  assert.equal(r.version, before.version);
  assert.equal((await store.requireSchema(K)).fields.find((f) => f.name === 'author')!.description, 'Author of the quote; Ukrainian writers only');
  await assert.rejects(applyDataSchemaSuggestion(store, { dataset: K, target: 'field', field: 'author', old_text: 'Who said it', new_text: 'x x x', evidence: 'stale suggestion text here' }), /stale/);
});

test('the nightly stats job refreshes every dataset', { skip }, async () => {
  const n = await new DataStatsCron(pool).refresh();
  assert.ok(n >= 13, `${n} datasets`);
});
