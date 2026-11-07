/**
 * Spec 079 FR-004 against a throwaway Postgres (its own migrated database, created and dropped here): migration 102.
 * - the eight `passed` rows of round 2 go to content_ledger_repairs, whole; a `published` row of the same ref and a
 *   `passed` row of another ref stay;
 * - the two descriptions change only from the 058 text (an owner's own wording stays), the schema version does not move;
 * - re-applying changes nothing; the down file puts the rows and the 058 descriptions back.
 * - the guard reads the real {num, text} rows of that database (num from 0).
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createMigratedDb, type FreshDb } from '../editor/sysadmin/testing/fresh-db';
import { checkQuizGroundTruth } from '../editor/post/quiz-ground-truth';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
const up = () => readFileSync(join(DB, '102_quiz_answer_key.sql'), 'utf8');
const down = () => readFileSync(join(DB, 'down', '102_quiz_answer_key.down.sql'), 'utf8');

const RES = 'telegram:@pdr_dev_channel';
const IDS = [57829, 57245, 57827, 57258, 57433, 57758, 57242, 57256];
const ANSWERS_058 = 'Answer options in order: an array of strings or of {text} objects.';
const KEY_058 = '1-based number of the correct option in answers. It is the official answer: never correct it from memory.';
const ANSWERS_102 = 'Answer options: an array of {num, text}; num counts from 0.';
const KEY_102 = 'The num of the correct option in answers (num counts from 0). It is the official answer: never correct it from memory.';

let db: FreshDb;
let schemaId = '';

const descriptions = async () => {
  const { rows } = await db.pool.query(`SELECT version, fields FROM data_schemas WHERE key = 'pdr_questions'`);
  const f = (n: string) => rows[0].fields.find((x: any) => x.name === n).description as string;
  return { version: rows[0].version as number, answers: f('answers'), key: f('correct_answer_num') };
};
const setDescriptions = (answers: string, key: string) => db.pool.query(
  `UPDATE data_schemas SET fields = (SELECT jsonb_agg(CASE WHEN e->>'name' = 'answers' THEN e || jsonb_build_object('description', $1::text)
                                                         WHEN e->>'name' = 'correct_answer_num' THEN e || jsonb_build_object('description', $2::text)
                                                         ELSE e END ORDER BY o) FROM jsonb_array_elements(fields) WITH ORDINALITY x(e, o))
    WHERE key = 'pdr_questions'`, [answers, key]);
const ledger = async () => (await db.pool.query(`SELECT resource_ref, source_ref, status, origin, note FROM content_ledger ORDER BY source_ref, status`)).rows;
const repairs = async () => (await db.pool.query(`SELECT repair, ledger_row FROM content_ledger_repairs ORDER BY ledger_row->>'source_ref'`)).rows;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'a079');
  schemaId = (await db.pool.query(`SELECT id FROM data_schemas WHERE key = 'pdr_questions'`)).rows[0].id;
  const version = (await descriptions()).version;
  // The eight rows of the review, with the real shape: {num, text}, num from 0, correct_answer_num a num (0 here).
  for (const id of IDS) {
    await db.pool.query(
      `INSERT INTO data_items (id, schema_id, schema_version, external_key, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, schemaId, version, String(id), JSON.stringify({
        question_id: id, ticket_number: 1, question_num: 1, text: 'Питання?',
        answers: [{ num: 0, text: 'Так' }, { num: 1, text: 'Ні' }, { num: 2, text: 'Не знаю' }], correct_answer_num: 0, explanation: 'п. 1',
      })]);
  }
  for (const id of IDS) {
    await db.pool.query(
      `INSERT INTO content_ledger (resource_ref, source_ref, origin, status, slot_id, note)
       VALUES ($1, $2, 'editor', 'passed', gen_random_uuid(), $3)`, [RES, `data://pdr_questions/${id}`, `quiz_answer_mismatch: row ${id}`]);
  }
  // Neighbours that must stay: a published row of one of the eight, a passed row of another row, a passed row of another dataset.
  await db.pool.query(`INSERT INTO content_ledger (resource_ref, source_ref, origin, status) VALUES ($1, 'data://pdr_questions/57829', 'editor', 'published')`, [RES]);
  await db.pool.query(`INSERT INTO content_ledger (resource_ref, source_ref, origin, status, note) VALUES ($1, 'data://pdr_questions/57000', 'editor', 'passed', 'critic_rejected: x')`, [RES]);
  await db.pool.query(`INSERT INTO content_ledger (resource_ref, source_ref, origin, status) VALUES ($1, 'data://prompts/57829', 'editor', 'passed')`, [RES]);
  // The 058 text, as on stage before the migration.
  await setDescriptions(ANSWERS_058, KEY_058);
});

after(async () => { if (db) await db.drop(); });

test('102: the descriptions say what the data is, and the eight rows are taken back whole', { skip }, async () => {
  const v0 = (await descriptions()).version;
  await db.pool.query(up());
  assert.deepEqual(await descriptions(), { version: v0, answers: ANSWERS_102, key: KEY_102 }, 'description edits keep the schema version');

  const rep = await repairs();
  assert.equal(rep.length, 8);
  assert.ok(rep.every((r) => r.repair === '102_quiz_answer_key'));
  assert.deepEqual(rep.map((r) => r.ledger_row.source_ref).sort(), IDS.map((i) => `data://pdr_questions/${i}`).sort());
  assert.equal(rep[0].ledger_row.resource_ref, RES);
  assert.equal(rep[0].ledger_row.status, 'passed');
  assert.match(rep[0].ledger_row.note, /^quiz_answer_mismatch/);
  assert.ok(rep[0].ledger_row.slot_id, 'the whole row, not a few columns');

  const left = await ledger();
  assert.equal(left.filter((r) => r.status === 'passed' && IDS.some((i) => r.source_ref === `data://pdr_questions/${i}`)).length, 0);
  assert.equal(left.length, 3);
  assert.ok(left.some((r) => r.source_ref === 'data://pdr_questions/57829' && r.status === 'published'), 'the published row stays');
  assert.ok(left.some((r) => r.source_ref === 'data://pdr_questions/57000' && r.status === 'passed'), 'a passed row of another ref stays');
  assert.ok(left.some((r) => r.source_ref === 'data://prompts/57829' && r.status === 'passed'), 'another dataset stays');
});

test('102: re-applying changes nothing; an owner\'s own wording is never overwritten', { skip }, async () => {
  const before = { ledger: await ledger(), repairs: (await repairs()).length, d: await descriptions() };
  await db.pool.query(up());
  assert.deepEqual(await ledger(), before.ledger);
  assert.equal((await repairs()).length, before.repairs, 'no second copy of anything');
  assert.deepEqual(await descriptions(), before.d);

  await setDescriptions('Owner wording for answers.', KEY_058);
  await db.pool.query(up());
  const d = await descriptions();
  assert.equal(d.answers, 'Owner wording for answers.', 'not the 058 text: left alone');
  assert.equal(d.key, KEY_102, 'the other field was still the 058 text');
  await setDescriptions(ANSWERS_102, KEY_102);
});

test('102 down: the saved rows and the 058 descriptions come back; the repair table goes; the owner\'s wording stays', { skip }, async () => {
  await db.pool.query(down());
  const back = await ledger();
  assert.equal(back.length, 11, '3 left + 8 restored');
  for (const id of IDS) assert.ok(back.some((r) => r.source_ref === `data://pdr_questions/${id}` && r.status === 'passed' && r.resource_ref === RES && r.origin === 'editor'), String(id));
  assert.equal((await db.pool.query(`SELECT to_regclass('content_ledger_repairs') AS t`)).rows[0].t, null);
  assert.equal((await db.pool.query(`SELECT 1 FROM schema_migrations WHERE version = '102_quiz_answer_key'`)).rowCount, 0);
  const d = await descriptions();
  assert.equal(d.answers, ANSWERS_058);
  assert.equal(d.key, KEY_058);

  // Down on its own is safe to repeat, and an owner's wording is not overwritten by it.
  await setDescriptions('Owner wording for answers.', KEY_102);
  await db.pool.query(down());
  assert.equal((await descriptions()).answers, 'Owner wording for answers.');
  assert.equal((await descriptions()).key, KEY_058);
  assert.equal((await ledger()).length, 11);
  await db.pool.query(up());
  assert.equal((await repairs()).length, 8, 'up again: the rows are taken back again');
});

test('the guard reads the real rows of the migrated database: num from 0', { skip }, async () => {
  const spec = (correct: number) => ({
    format: 'quiz', library_ref: 'data://pdr_questions/57256',
    poll: { question: 'q', options: ['Так', 'Ні', 'Не знаю'], correct_index: correct },
  }) as any;
  assert.equal(await checkQuizGroundTruth(db.pool, spec(0)), null, 'correct_answer_num 0 is the first option');
  assert.equal((await checkQuizGroundTruth(db.pool, spec(1)))?.error, 'quiz_answer_mismatch');
  await db.pool.query(`UPDATE data_items SET data = data || '{"correct_answer_num": 5}' WHERE id = 57256`);
  assert.equal((await checkQuizGroundTruth(db.pool, spec(0)))?.error, 'quiz_answer_key_invalid');
});
