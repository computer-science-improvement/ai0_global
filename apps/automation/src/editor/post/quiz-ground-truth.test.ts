import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuizGroundTruth, resolveAnswerKey } from './quiz-ground-truth';
import { makeSpec } from './testing/fixtures';

// Spec 079: the real pdr_questions shape — options are {num, text}, num counts from 0, correct_answer_num is a num.
const pool = (row: any) => ({ query: async () => ({ rows: row ? [row] : [] }) }) as any;
const quiz = (options: string[], correct: number, ref = 'library://pdr_questions/3f2b8c1e-9a4d-4e2b-8f7a-1c2d3e4f5a6b') =>
  makeSpec({ format: 'quiz', media: [], body: [], hashtags: [], origin: 'library', source: undefined, library_ref: ref, poll: { question: 'Q?', options, correct_index: correct } });
const opts = (...texts: string[]) => texts.map((text, num) => ({ num, text }));

// Shape of rows 57256 / 57555 (texts from apps/pipeline/src/data/normalized/pdr/tickets.json, question 943 for the long one).
const ROW_0 = { answers: opts('З 10 років', 'З 12 років', 'З 14 років'), correct_answer_num: 0, zero_based: true };
const ROW_3 = { answers: opts('A', 'B', 'C', 'D'), correct_answer_num: '3', zero_based: true };
const LONG = 'За умови наявності справного зчіпного пристрою у буксируваного транспортного засобу, а також у транспортного засобу, що буксирує.';
const LONG_ROW = {
  answers: opts(
    'За умови наявності технічно справного зчіпного пристрою лише у буксируваного транспортного засобу.',
    'За умови наявності технічно справного зчіпного пристрою тільки у транспортного засобу, що буксирує.',
    LONG),
  correct_answer_num: 2, zero_based: true,
};

test('correct_answer_num 0 marks the first option (the old reader found nothing and passed any option)', async () => {
  assert.equal(await checkQuizGroundTruth(pool(ROW_0), quiz(['з 10 років', 'З 12 років.', 'З 14 років'], 0)), null);
  for (const wrong of [1, 2]) {
    const r = await checkQuizGroundTruth(pool(ROW_0), quiz(['З 10 років', 'З 12 років', 'З 14 років'], wrong));
    assert.equal(r?.error, 'quiz_answer_mismatch');
    assert.match(r!.details, /num=0: "З 10 років"/);
    assert.match(r!.details, /по межі слова/);
  }
});

test('correct_answer_num 3 is the option with num 3, not the one after it', async () => {
  assert.equal(await checkQuizGroundTruth(pool(ROW_3), quiz(['A', 'B', 'C', 'D'], 3)), null);
  assert.equal((await checkQuizGroundTruth(pool(ROW_3), quiz(['A', 'B', 'C', 'D'], 0)))?.error, 'quiz_answer_mismatch');
});

test('options are matched by num, not by array position', async () => {
  const shuffled = { answers: [{ num: 2, text: 'C' }, { num: 0, text: 'A' }, { num: 1, text: 'B' }], correct_answer_num: 1, zero_based: true };
  assert.equal(await checkQuizGroundTruth(pool(shuffled), quiz(['A', 'B', 'C'], 1)), null);
  assert.equal((await checkQuizGroundTruth(pool(shuffled), quiz(['A', 'B', 'C'], 2)))?.error, 'quiz_answer_mismatch');
});

test('bare strings: base 0 when a 0 is present, base 1 otherwise', async () => {
  const bare = (n: unknown, zero: boolean) => ({ answers: ['A', 'B', 'C'], correct_answer_num: n, zero_based: zero });
  // the key is 0 → base 0 whatever the dataset says
  assert.equal(await checkQuizGroundTruth(pool(bare(0, false)), quiz(['A', 'B', 'C'], 0)), null);
  // the dataset has a 0 elsewhere → base 0: key 1 is 'B'
  assert.equal(await checkQuizGroundTruth(pool(bare(1, true)), quiz(['A', 'B', 'C'], 1)), null);
  assert.equal((await checkQuizGroundTruth(pool(bare(1, true)), quiz(['A', 'B', 'C'], 0)))?.error, 'quiz_answer_mismatch');
  // no 0 anywhere → base 1: key 1 is 'A'
  assert.equal(await checkQuizGroundTruth(pool(bare(1, false)), quiz(['A', 'B', 'C'], 0)), null);
  // key = option count → base 1 even when the dataset has a 0
  assert.equal(await checkQuizGroundTruth(pool(bare(3, true)), quiz(['A', 'B', 'C'], 2)), null);
  // {text} objects without num follow the same rule
  const objs = { answers: [{ text: 'A' }, { text: 'B' }], correct_answer_num: 2, zero_based: false };
  assert.equal(await checkQuizGroundTruth(pool(objs), quiz(['A', 'B'], 1)), null);
});

test('a key that names no option is quiz_answer_key_invalid, never a pass', async () => {
  const cases: Array<[string, any]> = [
    ['out of range', { answers: opts('A', 'B', 'C'), correct_answer_num: '5', zero_based: true }],
    ['null', { answers: opts('A', 'B', 'C'), correct_answer_num: null, zero_based: true }],
    ['not a number', { answers: opts('A', 'B', 'C'), correct_answer_num: 'x', zero_based: true }],
    ['no answers', { answers: [], correct_answer_num: 0, zero_based: true }],
    ['answers missing', { answers: null, correct_answer_num: 0, zero_based: true }],
    ['bare strings out of range', { answers: ['A', 'B'], correct_answer_num: 7, zero_based: false }],
  ];
  for (const [name, row] of cases) {
    const r = await checkQuizGroundTruth(pool(row), quiz(['A', 'B', 'C'], 0, 'data://pdr_questions/57256'));
    assert.equal(r?.error, 'quiz_answer_key_invalid', name);
    assert.match(r!.details, /^57256: /, name);
    assert.match(r!.details, /skip_slot з ref цього рядка/, name);
  }
  const five = await checkQuizGroundTruth(pool(cases[0][1]), quiz(['A', 'B', 'C'], 0, 'data://pdr_questions/57256'));
  assert.match(five!.details, /correct_answer_num = 5, варіантів з таким num немає \(є num 0, 1, 2\)/);
});

test('resolveAnswerKey is pure and reports the options it found', () => {
  const k = resolveAnswerKey({ answers: opts('A', 'B'), correct_answer_num: 1 }, { zeroBased: false });
  assert.deepEqual(k.ok && k.truth, { num: 1, text: 'B' });
  const bare = resolveAnswerKey({ answers: ['A', 'B'], correct_answer_num: 1 }, { zeroBased: true });
  assert.deepEqual(bare.ok && bare.truth, { num: 1, text: 'B' });
});

test('a long correct option cut at a word boundary passes (with or without «…»); cut mid-word fails', async () => {
  assert.ok(LONG.length > 100);
  const others = LONG_ROW.answers.slice(0, 2).map((a) => a.text.slice(0, 90));
  const cut = 'За умови наявності справного зчіпного пристрою у буксируваного транспортного засобу, а також у';
  assert.ok(cut.length <= 100);
  assert.equal(await checkQuizGroundTruth(pool(LONG_ROW), quiz([...others, cut], 2)), null);
  assert.equal(await checkQuizGroundTruth(pool(LONG_ROW), quiz([...others, `${cut}…`], 2)), null);
  assert.equal(await checkQuizGroundTruth(pool(LONG_ROW), quiz([...others, `${cut}...`], 2)), null);
  assert.equal(await checkQuizGroundTruth(pool(LONG_ROW), quiz([...others, `${cut.toUpperCase()}…`], 2)), null, 'case ignored');
  const midWord = await checkQuizGroundTruth(pool(LONG_ROW), quiz([...others, 'За умови наявності справного зчіпного пристрою у буксируваного транспортного засо'], 2));
  assert.equal(midWord?.error, 'quiz_answer_mismatch');
  assert.match(midWord!.details, /num=2/);
  // a short correct option never matches by prefix
  const short = { answers: opts('Так, можна', 'Ні'), correct_answer_num: 0, zero_based: true };
  assert.equal((await checkQuizGroundTruth(pool(short), quiz(['Так', 'Ні'], 0)))?.error, 'quiz_answer_mismatch');
});

test('FR-002: apostrophes (\' ’ ʼ) are one and the same in the exact and the cut comparison', async () => {
  const full = "Водій зобов'язаний подати сигнал світловими покажчиками повороту завчасно до початку маневру, а також переконатися у безпеці.";
  assert.ok(full.length > 100);
  const row = { answers: opts('Ні', 'Так', full), correct_answer_num: 2, zero_based: true };
  const cut = 'Водій зобовʼязаний подати сигнал світловими покажчиками повороту завчасно до початку';
  assert.ok(cut.length <= 100);
  assert.equal(await checkQuizGroundTruth(pool(row), quiz(['Ні', 'Так', cut], 2)), null);
  assert.equal(await checkQuizGroundTruth(pool(row), quiz(['Ні', 'Так', full.replace("'", 'ʼ')], 2)), null);
  assert.equal(await checkQuizGroundTruth(pool(row), quiz(['Ні', 'Так', full.replace("'", '’')], 2)), null);
});

test('a cut that is also the start of another option is refused as ambiguous', async () => {
  const shared = 'За умови наявності технічно справного зчіпного пристрою';
  const row = {
    answers: opts(
      'За умови наявності технічно справного зчіпного пристрою лише у буксируваного транспортного засобу, а не у того, що буксирує.',
      'За умови наявності технічно справного зчіпного пристрою у буксируваного транспортного засобу, а також у транспортного засобу, що буксирує.',
      'Без зчіпного пристрою'),
    correct_answer_num: 1, zero_based: true,
  };
  const r = await checkQuizGroundTruth(pool(row), quiz([row.answers[0].text.slice(0, 90), `${shared}…`, 'Без зчіпного пристрою'], 1));
  assert.equal(r?.error, 'quiz_answer_mismatch');
  assert.match(r!.details, /збігається з початком іншої відповіді/);
  // cut longer, past the shared start → fine
  assert.equal(await checkQuizGroundTruth(pool(row), quiz([row.answers[0].text.slice(0, 90), `${shared} у буксируваного транспортного засобу,`, 'Без зчіпного пристрою'], 1)), null);
});

test('data:// and library:// refs are checked against the same answer key; other refs are ignored', async () => {
  const calls: any[] = [];
  const p = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [{ answers: opts('A', 'B'), correct_answer_num: '1', zero_based: true }] }; } } as any;
  assert.equal((await checkQuizGroundTruth(p, quiz(['A', 'B'], 0, 'data://pdr_questions/15')))?.error, 'quiz_answer_mismatch');
  assert.deepEqual(calls[0].params, ['pdr_questions', null, '15']);
  assert.match(calls[0].sql, /EXISTS/, 'the dataset-wide zero check rides in the one query');
  assert.equal(calls.length, 1);
  assert.equal(await checkQuizGroundTruth(p, quiz(['A', 'B'], 1, 'data://pdr_questions/15')), null);
  assert.equal(await checkQuizGroundTruth(p, quiz(['A', 'B'], 0, 'data://books/15')), null);
  assert.equal(await checkQuizGroundTruth(pool(null), quiz(['A', 'B'], 0, 'library://facts/x')), null);
  assert.equal((await checkQuizGroundTruth(pool(null), quiz(['A', 'B'], 0)))?.error, 'library_ref_not_found');
});
