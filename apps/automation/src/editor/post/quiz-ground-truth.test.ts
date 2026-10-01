import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuizGroundTruth } from './quiz-ground-truth';
import { makeSpec } from './testing/fixtures';

const pool = (row: any) => ({ query: async () => ({ rows: row ? [row] : [] }) }) as any;
const quiz = (options: string[], correct: number, ref = 'library://pdr_questions/3f2b8c1e-9a4d-4e2b-8f7a-1c2d3e4f5a6b') =>
  makeSpec({ format: 'quiz', media: [], body: [], hashtags: [], origin: 'library', source: undefined, library_ref: ref, poll: { question: 'Q?', options, correct_index: correct } });

test('passes when the marked option equals the DB answer (punctuation/case-insensitive)', async () => {
  assert.equal(await checkQuizGroundTruth(pool({ answers: ['З 10 років', 'З 12 років'], correct_answer_num: 2 }), quiz(['з 10 років', 'З 12 років.'], 1)), null);
});

test('rejects a quiz whose correct option contradicts the DB', async () => {
  const r = await checkQuizGroundTruth(pool({ answers: ['З 12 років', 'З 14 років'], correct_answer_num: 1 }), quiz(['З 12 років', 'З 14 років'], 1));
  assert.equal(r?.error, 'quiz_answer_mismatch');
  assert.match(r!.details, /З 12 років/);
});

test('supports object answers and ignores non-pdr quizzes', async () => {
  assert.equal(await checkQuizGroundTruth(pool({ answers: [{ text: 'A' }, { text: 'B' }], correct_answer_num: 2 }), quiz(['A', 'B'], 1)), null);
  assert.equal(await checkQuizGroundTruth(pool(null), quiz(['A', 'B'], 0, 'library://facts/x')), null);
  assert.equal((await checkQuizGroundTruth(pool(null), quiz(['A', 'B'], 0)))?.error, 'library_ref_not_found');
});
