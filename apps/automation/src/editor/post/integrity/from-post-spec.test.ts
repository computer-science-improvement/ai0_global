import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPostFromSpec } from './from-post-spec';
import { bodyText } from './types';
import { runIntegrityChecks } from './registry';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';

const META = { id: 'slot-1', channel: '@chan', publishedAt: '2026-10-08T14:00:00+03:00', timezone: 'Europe/Kyiv' };

test('spec → AuditPost: reader text as rendered (blocks, → source, hashtags), lead, links, media', () => {
  const spec = makeSpec({
    body: [
      { type: 'lead', text: '**Телескоп** Вебб показав туманність' },
      { type: 'p', text: 'Деталі в [звіті NASA](https://nasa.gov/report).' },
      { type: 'list', items: ['Перше', 'Друге'] },
    ],
    hashtags: ['Космос', '#nasa'],
  });
  const p = auditPostFromSpec(spec, META);
  assert.equal(p.text, 'Телескоп Вебб показав туманність\n\nДеталі в звіті NASA.\n\n• Перше\n• Друге\n\n→ NASA\n\n#космос #nasa');
  assert.equal(p.lead, 'Телескоп Вебб показав туманність');
  assert.deepEqual(p.links, [{ text: 'звіті NASA', url: 'https://nasa.gov/report' }, { text: 'NASA', url: 'https://nasa.gov/ring' }]);
  assert.equal(p.sourceUrl, 'https://nasa.gov/ring');
  assert.deepEqual(p.hashtags, ['космос', 'nasa']);
  assert.deepEqual(p.media, { kind: 'photo', count: 1 });
  assert.equal(p.publishedAt, META.publishedAt);
  assert.equal(p.timezone, 'Europe/Kyiv');
  assert.equal(bodyText(p), 'Телескоп Вебб показав туманність\n\nДеталі в звіті NASA.\n\n• Перше\n• Друге', 'the body drops the rendered trailer');
});

test('spec → AuditPost: footer / button link styles, cta and buttons, no lead block', () => {
  const spec = makeSpec({
    format: 'text', media: [], body: [{ type: 'p', text: 'Текст без жирного вступу.' }],
    cta: { url: 'https://shop.example/x', label: 'Купити' },
    buttons: [[{ text: 'Сайт', url: 'https://site.example' }]],
  });
  const footer = auditPostFromSpec(spec, { ...META, card: { linkStyle: 'footer', footer: '@chan' } });
  assert.equal(footer.text, 'Текст без жирного вступу.\n\n@chan\nДжерело: NASA\n#космос');
  assert.equal(footer.sourceUrl, undefined);
  assert.equal(footer.lead, undefined);
  assert.equal(footer.media, null);
  const button = auditPostFromSpec(spec, { ...META, card: { linkStyle: 'button' } });
  assert.deepEqual(button.buttons, [
    { text: 'Купити', url: 'https://shop.example/x' },
    { text: 'Джерело: NASA', url: 'https://nasa.gov/ring' },
    { text: 'Сайт', url: 'https://site.example' },
  ]);
  assert.ok(!button.text.includes('NASA'), 'a button source is not in the text');
});

test('spec → AuditPost: polls and quizzes', () => {
  const quiz = auditPostFromSpec(makeSpec({
    format: 'quiz', media: [], body: [], hashtags: [],
    poll: { question: 'Скільки активних параметрів?', options: ['49 млрд', '1,05 трлн'], correct_index: 0, explanation: 'Лише **49 млрд** на токен.', anonymous: false },
  }), META);
  assert.deepEqual(quiz.poll, { question: 'Скільки активних параметрів?', options: ['49 млрд', '1,05 трлн'], kind: 'quiz', anonymous: false, correctIndex: 0, explanation: 'Лише 49 млрд на токен.' });
  const poll = auditPostFromSpec(makeSpec({ format: 'poll', media: [], body: [], hashtags: [], poll: { question: 'Що оберете?', options: ['А', 'Б'] } }), META);
  assert.deepEqual(poll.poll, { question: 'Що оберете?', options: ['А', 'Б'], kind: 'regular', anonymous: true });
});

test('spec → AuditPost: carousel slides and the longread article are reader text', () => {
  const car = auditPostFromSpec(makeSpec({
    format: 'carousel', media: [],
    slides: [{ title: 'Один', text: 'Перший слайд.' }, { title: 'Два', text: 'Другий слайд.' }],
  }), META);
  assert.ok(car.text.includes('Один\nПерший слайд.') && car.text.includes('Два\nДругий слайд.'));
  assert.deepEqual(car.media, { kind: 'photo', count: 2 });
  const lr = auditPostFromSpec(makeSpec({
    format: 'longread', media: [],
    longread: { title: 'Стаття', blocks: [{ type: 'p', text: 'Повний текст із [посиланням](https://a.example/b).' }] },
  }), META);
  assert.ok(lr.text.includes('Стаття\n\nПовний текст із посиланням.'));
  assert.ok(lr.links.some((l) => l.url === 'https://a.example/b'));
});

test('the integrity checks agree with lintPost on a spec (same slop phrase, same reader-question cap)', () => {
  const spec = makeSpec({
    body: [
      { type: 'lead', text: 'Варто зазначити: телескоп показав туманність' },
      { type: 'p', text: 'Як думаєте, що там? А ви бачили її в бінокль?' },
    ],
  });
  const card = makeCard({ readerQuestionsMax: 1 });
  const lint = lintPost(spec, card);
  const audit = runIntegrityChecks(auditPostFromSpec(spec, META), { previous: [], card: { readerQuestionsMax: 1 } });
  const codes = (xs: Array<{ code: string }>) => [...new Set(xs.map((x) => x.code))].sort();
  assert.deepEqual(codes(audit.filter((f) => f.level === 'error')), ['banned_term', 'reader_questions']);
  assert.deepEqual(codes(audit.filter((f) => f.level === 'error')), codes(lint.errors.filter((e) => ['banned_term', 'reader_questions'].includes(e.code))));
});
