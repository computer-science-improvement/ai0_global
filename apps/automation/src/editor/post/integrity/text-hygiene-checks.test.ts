/** Spec 037 T6: the text hygiene integrity checks, one by one, and through lintPost. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditContext, AuditPost } from './types';
import { textReplacementCharCheck } from './checks/text-replacement-char';
import { mixedScriptWordCheck } from './checks/mixed-script-word';
import { processLeakCheck } from './checks/process-leak';
import { duplicateAttributionCheck } from './checks/duplicate-attribution';
import { duplicateSourceLinkCheck } from './checks/duplicate-source-link';
import { leadLimits, leadTooLongCheck } from './checks/lead-too-long';
import { verbatimRepeat, verbatimRepeatCheck } from './checks/verbatim-repeat';
import { decimalMixedCheck, mixedDecimals } from './checks/decimal-mixed';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';

const post = (o: Partial<AuditPost> = {}): AuditPost => ({
  id: 't:1', channel: 't', publishedAt: '2026-10-11T12:00:00+03:00', timezone: 'Europe/Kyiv',
  text: 'Звичайний текст.', links: [], buttons: [], hashtags: [], media: null, ...o,
});
const ctx: AuditContext = { previous: [] };
const levels = (fs: Array<{ level: string }>) => fs.map((f) => f.level);

test('text_replacement_char: U+FFFD in the text or a button is an error with the broken word', () => {
  const f = textReplacementCharCheck.run(post({ text: 'Постраждалі пе��еважно в Азії.' }), ctx);
  assert.deepEqual(f.map((x) => [x.code, x.level, x.excerpt]), [['text_replacement_char', 'error', 'пе��еважно']]);
  assert.equal(textReplacementCharCheck.run(post({ buttons: [{ text: 'Чит\uFFFDти' }] }), ctx).length, 1);
  assert.deepEqual(textReplacementCharCheck.run(post(), ctx), []);
});

test('mixed_script_word: «Меркoff» and #aiновини are errors with a hint; iPhone-ом is fine', () => {
  const f = mixedScriptWordCheck.run(post({ text: 'Хорор про корпорацію Меркoff на iPhone-ом.\n\n#aiновини' }), ctx);
  assert.deepEqual(f.map((x) => [x.excerpt, x.level]), [['Меркoff', 'error'], ['#aiновини', 'error']]);
  assert.match(f[0].message, /одним алфавітом/);
  assert.match(f[1].message, /хештег/);
});

test('process_leak: explicit phrases are errors, softer ones warnings, news sentences nothing', () => {
  const leak = processLeakCheck.run(post({ text: 'Актуальних промокодів на сьогодні не знайшлось, тому в пості лише перевірені роздачі.' }), ctx);
  assert.deepEqual(levels(leak), ['error']);
  for (const s of ['Я перевірив усі магазини.', 'За моїми даними, реліз скоро.', 'Згідно з брифом, пишемо про ігри.', 'Інструмент повернув порожній список.', 'На жаль, не вдалося знайти дату.']) {
    assert.deepEqual(levels(processLeakCheck.run(post({ text: s }), ctx)), ['error'], s);
  }
  assert.deepEqual(levels(processLeakCheck.run(post({ text: 'Мені не вдалося знайти підтвердження в інших джерелах.' }), ctx)), ['warning']);
  assert.deepEqual(processLeakCheck.run(post({ text: 'Рятувальники перевірили будинок. Постраждалих немає.' }), ctx), []);
});

test('duplicate_attribution: «Джерело: X» next to the rendered «→ X» line is a warning; another source or no rendered source is not', () => {
  const url = 'https://techcrunch.com/2026/10/08/openai/';
  const base = { sourceUrl: url, links: [{ text: 'TechCrunch', url }] };
  const f = duplicateAttributionCheck.run(post({ ...base, text: 'Цифри від FT.\n\nДжерело: Financial Times через TechCrunch\n\n→ TechCrunch' }), ctx);
  assert.deepEqual(f.map((x) => [x.code, x.level]), [['duplicate_attribution', 'warning']]);
  assert.equal(duplicateAttributionCheck.run(post({ ...base, text: 'Абзац. Джерело: TechCrunch\n\n→ TechCrunch' }), ctx).length, 1, 'closing a paragraph');
  assert.deepEqual(duplicateAttributionCheck.run(post({ ...base, text: 'Джерело: Reuters\n\n→ TechCrunch' }), ctx), []);
  assert.deepEqual(duplicateAttributionCheck.run(post({ text: 'Джерело: TechCrunch' }), ctx), [], 'no rendered source');
  const button = post({ text: 'Абзац.\nДжерело: NASA', buttons: [{ text: 'Джерело: NASA', url: 'https://nasa.gov/x' }] });
  assert.equal(duplicateAttributionCheck.run(button, ctx).length, 1, 'a «Джерело» button counts as the rendered source');
});

test('lead_too_long: > 140 warning, > 220 error; the style limit moves the thresholds', () => {
  const lead = (n: number) => 'а'.repeat(n);
  assert.deepEqual(leadTooLongCheck.run(post({ lead: lead(140) }), ctx), []);
  assert.deepEqual(levels(leadTooLongCheck.run(post({ lead: lead(141) }), ctx)), ['warning']);
  assert.deepEqual(levels(leadTooLongCheck.run(post({ lead: lead(220) }), ctx)), ['warning']);
  assert.deepEqual(levels(leadTooLongCheck.run(post({ lead: lead(221) }), ctx)), ['error']);
  assert.deepEqual(leadTooLongCheck.run(post({}), ctx), [], 'no lead');
  assert.deepEqual(leadLimits({ style: { headline: { max_chars: 100 } } }), { warn: 100, error: 220 });
  assert.deepEqual(leadLimits({ style: { headline: { max_chars: 200 } } }), { warn: 200, error: 300 });
  assert.deepEqual(leadLimits({ style: { headline: 'short' } } as never), { warn: 140, error: 220 }, 'unknown shape → defaults');
  assert.deepEqual(levels(leadTooLongCheck.run(post({ lead: lead(120) }), { previous: [], card: { style: { headline: { max_chars: 100 } } } })), ['warning']);
});

test('verbatim_repeat: a 4-word run twice is a warning; Latin names and overlaps are not', () => {
  assert.equal(verbatimRepeat('У Steam дуже позитивні відгуки. Гра довга. У Steam дуже позитивні відгуки.'), 'steam дуже позитивні відгуки');
  assert.equal(verbatimRepeat('Epic роздає Out of Sight і TerraScape. Забрати Out of Sight і TerraScape можна до 15 жовтня.'), null);
  assert.equal(verbatimRepeat('дуже дуже дуже дуже дуже'), null, 'overlapping runs are one');
  assert.deepEqual(levels(verbatimRepeatCheck.run(post({ text: 'Ця гра стала хітом сезону. А ця гра стала хітом сезону теж.' }), ctx)), ['warning']);
});

test('decimal_mixed: «2,5» with «2.0» is a warning; dates, versions after a Latin name and thousands are not', () => {
  assert.deepEqual(mixedDecimals('2,5 млрд параметрів, результат з 2.0 до 47.0.'), { comma: '2,5', dot: '2.0' });
  assert.deepEqual(mixedDecimals('ціна $0.10 замість 1,05'), { comma: '1,05', dot: '0.10' });
  assert.equal(mixedDecimals('73,43% проти 14,81%; Gemini 2.5 і Mellum2.1, реліз 13.10.'), null);
  assert.equal(mixedDecimals('1,164 помилки і 2.0 бали'), null, 'three digits after a comma may be thousands');
  assert.deepEqual(levels(decimalMixedCheck.run(post({ text: '2,5 млрд, з 2.0 до 47.0.' }), ctx)), ['warning']);
});

test('lintPost: a broken char and an over-long lead block the post; the hygiene warnings reach lint warnings', () => {
  const card = makeCard({ hashtags: [] });
  const broken = lintPost(makeSpec({ body: [{ type: 'lead', text: 'Ledger призупинила продажі' }, { type: 'p', text: 'Постраждалі пе�еважно в Азії.' }] }), card);
  assert.ok(broken.errors.some((e) => e.code === 'text_replacement_char' && e.message.includes('пе�еважно')));
  const long = lintPost(makeSpec({ body: [{ type: 'lead', text: `${'Дуже довгий лід про туманність, '.repeat(8)}кінець.` }] }), card);
  assert.ok(long.errors.some((e) => e.code === 'lead_too_long'));
  const repeat = lintPost(makeSpec({ body: [{ type: 'lead', text: 'Вебб зняв туманність' }, { type: 'p', text: 'Ця гра стала хітом сезону. А ця гра стала хітом сезону теж.' }] }), card);
  assert.ok(repeat.ok);
  assert.ok(repeat.warnings.some((w) => w.code === 'verbatim_repeat'));
});

test('063 duplicate_source_link: an inline anchor to the source next to the rendered source line is a warning (www, slash, utm do not matter)', () => {
  const url = 'https://www.techcrunch.com/2026/10/08/openai/';
  const arrow = { text: 'TechCrunch', url };
  const f = duplicateSourceLinkCheck.run(post({ citedSourceUrl: url, sourceUrl: url, links: [{ text: 'за даними TechCrunch', url: 'https://techcrunch.com/2026/10/08/openai?utm_source=x' }, arrow] }), ctx);
  assert.deepEqual(f.map((x) => [x.code, x.level, x.excerpt]), [['duplicate_source_link', 'warning', 'за даними TechCrunch']]);
  assert.deepEqual(duplicateSourceLinkCheck.run(post({ citedSourceUrl: url, sourceUrl: url, links: [arrow] }), ctx), [], 'the source line alone');
  assert.deepEqual(duplicateSourceLinkCheck.run(post({ citedSourceUrl: url, sourceUrl: url, links: [{ text: 'інша стаття', url: 'https://techcrunch.com/other' }, arrow] }), ctx), [], 'another page');
  assert.deepEqual(duplicateSourceLinkCheck.run(post({ links: [{ text: 'a', url }, { text: 'b', url }] }), ctx), [], 'no cited source');
  // A «Джерело» button is the rendered source: one inline anchor is enough.
  const button = post({ citedSourceUrl: url, links: [{ text: 'TechCrunch', url }], buttons: [{ text: 'Джерело: TechCrunch', url }] });
  assert.equal(duplicateSourceLinkCheck.run(button, ctx).length, 1);
});
