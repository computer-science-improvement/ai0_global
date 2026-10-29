import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPost } from './lint-post';
import { makeCard, makeSpec } from './testing/fixtures';

/** Spec 073 FR-008 (A49): a question with a right answer is a quiz. A poll that carries `correct_index` fails lint. */

const card = () => makeCard({ formats: { text: 1, poll: 1, quiz: 1 } });
const poll = (format: 'poll' | 'quiz', p: Record<string, unknown>) =>
  makeSpec({ format, media: [], body: [], hashtags: [], poll: { question: 'Яка планета найбільша?', options: ['Марс', 'Юпітер'], ...p } });
const codes = (spec: any) => lintPost(spec, card()).errors.map((e) => e.code);

test('a poll with correct_index fails lint with poll_correct_index, and the message tells how to fix it', () => {
  const r = lintPost(poll('poll', { correct_index: 1 }), card());
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.code), ['poll_correct_index']);
  assert.match(r.errors[0].message, /correct_index/);
  assert.match(r.errors[0].message, /quiz/);
});

test('correct_index 0 counts as a right answer: the poll still fails', () => {
  assert.deepEqual(codes(poll('poll', { correct_index: 0 })), ['poll_correct_index']);
});

test('a quiz with correct_index passes; a poll without one passes', () => {
  const quiz = lintPost(poll('quiz', { correct_index: 1, explanation: 'Юпітер — найбільша.' }), card());
  assert.equal(quiz.ok, true, JSON.stringify(quiz.errors));
  const plain = lintPost(poll('poll', {}), card());
  assert.equal(plain.ok, true, JSON.stringify(plain.errors));
});

test('a quiz without correct_index is still quiz_correct_index, and a poll error does not hide the duplicate-option error', () => {
  assert.ok(codes(poll('quiz', {})).includes('quiz_correct_index'));
  const both = codes(poll('poll', { options: ['a', 'A'], correct_index: 0 }));
  assert.ok(both.includes('poll_correct_index'));
  assert.ok(both.includes('poll_options'));
});
