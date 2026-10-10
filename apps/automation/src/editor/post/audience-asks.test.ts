/**
 * Spec 034 FR-005: reader-directed questions (the tested marker list), the caps resolver (defaults, news,
 * quiz) and the lint error over the cap in the Telegram and platform lints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audienceCaps, audienceCapsOfProfile, contentKindOf, isReaderQuestion, READER_MARKERS, readerQuestions, readerQuestionsIssue,
} from './audience-asks';
import { lintPost } from './lint-post';
import { makeCard, makeSpec } from './testing/fixtures';
import { lintPlatformPost, PlatformPostSpecSchema } from '../platform/platform-spec';

// ── which questions address the reader ───────────────────────────────────────

test('reader markers: every listed marker makes a question reader-directed (any case)', () => {
  for (const m of READER_MARKERS) {
    const word = m.replace(/\*/g, 'і');
    const s = `${word.charAt(0).toUpperCase()}${word.slice(1)} — ну то що там із ракетою?`;
    assert.ok(isReaderQuestion(s), `${m}: ${s}`);
  }
  assert.equal(new Set(READER_MARKERS).size, READER_MARKERS.length, 'no duplicates');
});

test('reader questions: typical audience asks are counted', () => {
  for (const q of [
    'Як думаєте, коли люди полетять на Марс?', 'А ви вже пробували цей рецепт?', 'Чи доводилось вам бачити полярне сяйво?',
    'Напишіть у коментарях, що обрали б ви?', 'Що обираєте на вечерю в будні?', 'Знаєш, скільки важить хмара?',
    'Уявіть, що ви на МКС — що зробили б першим?', 'Який твій улюблений фільм Нолана?', 'Згодні?', 'Як вам такий поворот?',
  ]) assert.ok(isReaderQuestion(q), q);
});

test('reader questions: rhetorical and factual questions, statements and quoted speech are not counted', () => {
  for (const q of [
    'Що це означає для ринку?', 'Чи вплине це на ціни на пальне?', 'Коли запуск?', 'Хто б міг подумати?',
    'Ви можете подивитися запис на сайті NASA.', // a statement, not a question
    'Чи буде відкрите небо над Києвом?', 'Що відбувається в Бангладеш?', 'Що змінилося за два століть?',
  ]) assert.ok(!isReaderQuestion(q), q);
  assert.deepEqual(readerQuestions('Мер спитав журналістів: «Ви готові до зими?» Відповіді не було.'), []);
  assert.deepEqual(readerQuestions('Ракета злетіла о 10:00. А ви дивилися запуск? Наступний — у березні.'), ['А ви дивилися запуск?']);
});

test('readerQuestionsIssue: over the cap only; the default cap is 1; cap 0 names the news rule', () => {
  const two = 'Як думаєте, чи полетить? Ракета готова. А ви б полетіли?';
  assert.equal(readerQuestionsIssue('А ви дивилися запуск?', undefined), null);
  assert.equal(readerQuestionsIssue(two, undefined)?.code, 'reader_questions');
  assert.match(readerQuestionsIssue(two, 1)!.message, /питань до читачів 2, ліміт ресурсу 1 на пост/);
  assert.equal(readerQuestionsIssue(two, 2), null);
  assert.match(readerQuestionsIssue('А ви дивилися запуск?', 0)!.message, /новинний ресурс — без питань/);
});

// ── caps ─────────────────────────────────────────────────────────────────────

test('caps: defaults — 1 poll a week, 1 reader question per post', () => {
  assert.deepEqual(audienceCaps(null, 'Космос і астрономія'), { kind: 'general', kindInferred: true, pollsPerWeek: 1, questionsPerDay: 1 });
  assert.deepEqual(audienceCaps({}, null), { kind: 'general', kindInferred: true, pollsPerWeek: 1, questionsPerDay: 1 });
});

test('caps: a news resource gets 0 reader questions (content_kind or a news topic); explicit values win', () => {
  assert.equal(audienceCaps({ content_kind: 'news' }, 'Космос').questionsPerDay, 0);
  assert.deepEqual(contentKindOf(null, 'Новини Києва за день'), { kind: 'news', inferred: true });
  assert.equal(audienceCaps(null, 'Tech news digest').questionsPerDay, 0);
  assert.equal(audienceCaps({ content_kind: 'general' }, 'Новини Києва').questionsPerDay, 1, 'an explicit kind beats the topic');
  assert.equal(audienceCaps({ content_kind: 'news', questions_to_readers_per_day: 1 }, null).questionsPerDay, 1, 'the owner may allow one');
  assert.equal(audienceCaps({ polls_per_week: 3 }, null).pollsPerWeek, 3);
});

test('caps: a quiz resource has no default poll cap; education keeps the default', () => {
  assert.equal(audienceCaps({ content_kind: 'quiz' }, null).pollsPerWeek, null);
  assert.equal(audienceCaps({ content_kind: 'quiz', polls_per_week: 14 }, null).pollsPerWeek, 14);
  assert.equal(audienceCaps({ content_kind: 'education' }, null).pollsPerWeek, 1);
});

test('caps of a stored profile JSON tolerate anything malformed', () => {
  assert.deepEqual(audienceCapsOfProfile(null), audienceCaps(null, null));
  assert.equal(audienceCapsOfProfile({ topic: 'Новини', format_prefs: { polls_per_week: 'lots', content_kind: 'weird' } }).questionsPerDay, 0);
  assert.equal(audienceCapsOfProfile({ format_prefs: { polls_per_week: 2, questions_to_readers_per_day: 0 } }).pollsPerWeek, 2);
});

// ── lint ─────────────────────────────────────────────────────────────────────

const body = (...ps: string[]) => [{ type: 'lead', text: 'Телескоп Вебб показав туманність Кільце' }, ...ps.map((text) => ({ type: 'p', text }))];

test('lintPost: a second reader question fails; one passes; a news card (0) fails on the first', () => {
  const one = makeSpec({ body: body('На знімку видно оболонки газу. А ви бачили туманність у телескоп?') });
  const two = makeSpec({ body: body('Як думаєте, що це за газ?', 'На знімку видно оболонки газу. А ви бачили туманність у телескоп?') });
  assert.ok(lintPost(one, makeCard()).ok, JSON.stringify(lintPost(one, makeCard()).errors));
  const r = lintPost(two, makeCard());
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'reader_questions'), JSON.stringify(r.errors));
  const news = lintPost(one, makeCard({ readerQuestionsMax: 0 }));
  assert.ok(news.errors.some((e) => e.code === 'reader_questions'));
  assert.ok(lintPost(two, makeCard({ readerQuestionsMax: 2 })).ok);
});

test('lintPost: the poll question itself is not a reader question', () => {
  const poll = makeSpec({
    format: 'poll', hashtags: [], media: [], source: undefined, origin: 'original', body: [],
    poll: { question: 'Яку планету ви б обрали для колонії?', options: ['Марс', 'Венеру'] },
  });
  const r = lintPost(poll, makeCard({ readerQuestionsMax: 0 }));
  assert.ok(!r.errors.some((e) => e.code === 'reader_questions'), JSON.stringify(r.errors));
});

test('lintPlatformPost: the cap comes with the voice context (default 1)', () => {
  const spec = PlatformPostSpecSchema.parse({
    format: 'th_text', title: 'Туманність', caption: 'Вебб показав туманність Кільце. Як думаєте, що там? А ви бачили її?',
  });
  assert.ok(lintPlatformPost(spec, { platform: 'threads' }).errors.some((e) => e.code === 'reader_questions'));
  assert.ok(!lintPlatformPost(spec, { platform: 'threads', voice: { readerQuestionsMax: 2 } }).errors.some((e) => e.code === 'reader_questions'));
  const one = PlatformPostSpecSchema.parse({ format: 'th_text', title: 'Туманність', caption: 'Вебб показав туманність Кільце. А ви бачили її?' });
  assert.ok(lintPlatformPost(one, { platform: 'threads', voice: { readerQuestionsMax: 0 } }).errors.some((e) => e.code === 'reader_questions'), 'news: 0');
});
