import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAnswerKeys } from './quiz-ground-truth';

const pool = (zero: boolean) => ({ query: async () => ({ rows: [{ zero_based: zero }] }) }) as any;
const pdr = { id: '7', key: 'pdr_questions' };

test('query_data pdr rows carry correct_index by num (0-based data), never «correct_answer_num − 1»', async () => {
  const rows = [{ ref: 'data://pdr_questions/1', answers: [{ num: 0, text: 'Гальмувати' }, { num: 1, text: 'Подати звуковий сигнал' }, { num: 2, text: 'Обʼїхати' }], correct_answer_num: '2' }];
  const [r]: any[] = await withAnswerKeys(pool(true), pdr, rows);
  assert.equal(r.correct_index, 2);
  assert.equal(r.correct_answer_text, 'Обʼїхати');
});

test('a broken key is flagged; other datasets and rows without the fields are untouched', async () => {
  const [bad]: any[] = await withAnswerKeys(pool(true), pdr, [{ ref: 'data://pdr_questions/2', answers: [{ num: 0, text: 'А' }], correct_answer_num: '5' }]);
  assert.match(bad.answer_key_error, /num = 5|correct_answer_num = 5/);
  assert.equal(bad.correct_index, undefined);
  const other = [{ answers: [{ num: 0, text: 'А' }], correct_answer_num: '0' }];
  assert.strictEqual(await withAnswerKeys(pool(true), { id: '1', key: 'quiz' }, other), other);
  const noKey = [{ ref: 'x', question: 'Q' }];
  assert.strictEqual(await withAnswerKeys(pool(true), pdr, noKey), noKey);
});
