import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPost } from './lint-post';
import { sharedRun } from './verbatim-guard';
import { makeCard, makeSpec } from './testing/fixtures';

/** Spec 069 FR-007: origin=original is checked against what the run read (`origin_mismatch`). */

const READ = 'Телескоп Вебб показав туманність Кільце: оболонки газу, які зоря скинула тисячі років тому, світяться в інфрачервоному діапазоні яскравіше за саму зорю, і це видно навіть на оглядовому знімку.';
const COPY = 'оболонки газу, які зоря скинула тисячі років тому, світяться в інфрачервоному діапазоні яскравіше';
const original = (text: string, over: Record<string, unknown> = {}) =>
  makeSpec({ origin: 'original', source: undefined, body: [{ type: 'lead', text: 'Нова туманність' }, { type: 'p', text }], ...over });
const lintWith = (spec: any, sources: Array<{ url: string; text?: string }> | undefined) =>
  lintPost(spec, makeCard(), sources ? { ctx: { sources } } : {});
const mismatch = (r: ReturnType<typeof lintPost>) => r.errors.some((e) => e.code === 'origin_mismatch');

test('origin=original with an 80-char run from a source the run read is origin_mismatch, with the way out in the hint', () => {
  assert.ok(COPY.length >= 80);
  const r = lintWith(original(`Дивіться, що знайшли: ${COPY}. Красиво.`), [{ url: 'https://nasa.gov/ring', text: READ }]);
  assert.deepEqual(r.errors.map((e) => e.code), ['origin_mismatch']);
  assert.match(r.errors[0].message, /nasa\.gov\/ring/);
  assert.match(r.errors[0].message, /origin=library \+ library_ref/);
  assert.match(r.errors[0].message, /origin=external \+ source\.url/);
});

test('case and spacing do not hide the copy; a run just under 80 chars passes', () => {
  assert.equal(mismatch(lintWith(original(COPY.toUpperCase().replace(/ /g, '  ')), [{ url: 'u', text: READ }])), true);
  assert.equal(mismatch(lintWith(original(`Власні слова: ${COPY.slice(0, 70)}.`), [{ url: 'u', text: READ }])), false);
});

test('the copied passage may sit anywhere in a long page, not only in its first 8 000 chars', () => {
  const page = `${'Вступ про історію телескопів і про те, як їх будували. '.repeat(400)}${READ}${' Кінець сторінки.'.repeat(50)}`;
  assert.ok(page.indexOf(READ) > 20_000);
  assert.equal(mismatch(lintWith(original(COPY), [{ url: 'https://nasa.gov/long', text: page }])), true);
});

test('library + library_ref, external + source, no sources and sources without text all pass', () => {
  const src = [{ url: 'library://recipes/5', text: READ }];
  const lib = makeSpec({ origin: 'library', source: undefined, library_ref: 'library://recipes/5', body: [{ type: 'lead', text: 'Нова туманність' }, { type: 'p', text: COPY }] });
  assert.equal(mismatch(lintWith(lib, src)), false);
  const ext = makeSpec({ origin: 'external', body: [{ type: 'lead', text: 'Нова туманність' }, { type: 'p', text: COPY }] });
  assert.equal(mismatch(lintWith(ext, src)), false);
  assert.equal(mismatch(lintWith(original(COPY), undefined)), false, 'no sources: no error');
  assert.equal(mismatch(lintWith(original(COPY), [])), false);
  assert.equal(mismatch(lintWith(original(COPY), [{ url: 'u' }, { url: 'v', text: '  ' }])), false);
});

test('a carousel slide that copies the source is caught too (the reader text, not only the body)', () => {
  const slides = [{ title: 'Один', text: 'Перший слайд про щось інше.' }, { title: 'Два', text: COPY }];
  const spec = original('Короткий вступ про знімок.', { format: 'carousel', media: [], slides: slides.map((s) => ({ ...s, image: 'https://images.nasa.gov/a.jpg' })) });
  assert.equal(mismatch(lintWith(spec, [{ url: 'u', text: READ }])), true);
});

test('sharedRun finds a verbatim run of 80+ chars anywhere in a source, folding case and whitespace', () => {
  const page = `${'Інший текст про телескопи. '.repeat(1200)}${COPY} за саму зорю.${' Ще слова.'.repeat(500)}`;
  assert.ok(page.indexOf(COPY) > 20_000);
  assert.ok(sharedRun(`Пишу: ${COPY.toUpperCase().replace(/ /g, '   ')}!`, page) >= COPY.length);
  assert.equal(sharedRun('Зовсім інші слова про щось інше, ніж у джерелі, і довші за вісімдесят символів загалом, щоб не бути коротшими.', page), 0);
  assert.equal(sharedRun(COPY.slice(0, 79), page), 0, 'under the minimum nothing is reported');
  assert.equal(sharedRun('', page), 0);
  assert.equal(sharedRun(COPY, ''), 0);
});
