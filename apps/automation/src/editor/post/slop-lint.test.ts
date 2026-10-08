import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBannedTerms, findSlopPhrases, normalizeSlop, phraseRegex, SLOP_PHRASES } from './slop-phrases';
import {
  adjectiveTriple, HUMOR_MARKERS, isSlopWarning, moralCloser, rhetoricalQa, SLANG_MARKERS, SLOP_WARNING_CODES, slopWarnings,
} from './slop-lint';
import { lintPost } from './lint-post';
import { lintPlatformPost, PlatformPostSpecSchema } from '../platform/platform-spec';
import { makeCard, makeSpec } from './testing/fixtures';

const codes = (body: string, prefs?: Parameters<typeof slopWarnings>[0]['prefs']) => slopWarnings({ body, prefs }).map((w) => w.code);

// ── phrase list ──────────────────────────────────────────────────────────────

test('slop phrases: at least 80, unique, every one normalised and compilable', () => {
  assert.ok(SLOP_PHRASES.length >= 80, `${SLOP_PHRASES.length}`);
  assert.equal(new Set(SLOP_PHRASES).size, SLOP_PHRASES.length, 'no duplicates');
  for (const p of SLOP_PHRASES) {
    assert.equal(normalizeSlop(p), p, `normalised: ${p}`);
    assert.ok(!/[’']/.test(p), `apostrophe is ʼ: ${p}`);
    assert.doesNotThrow(() => phraseRegex(p));
    // Each phrase catches itself written as a writer would (capitalised, comma before «що», ’ apostrophe).
    const written = p.replace(/\*/g, 'а').replace(/ʼ/g, '’').replace(/^./, (c) => c.toUpperCase());
    assert.ok(findSlopPhrases(`Текст. ${written} далі.`).length > 0, `self-match: ${p}`);
  }
});

test('slop phrases: apostrophes ʼ ’ \' and case are unified; commas do not hide a phrase', () => {
  for (const s of ['Це невідʼємна частина міста.', 'Це невід’ємна частина міста.', "Це НЕВІД'ЄМНА частина міста.", 'Це невід`ємною частиною стало.']) {
    assert.deepEqual(findSlopPhrases(s).length, 1, s);
  }
  assert.deepEqual(findSlopPhrases('Очевидно, що ракета полетить.'), ['очевидно що']);
  assert.deepEqual(findSlopPhrases('Варто   зазначити:\nзапуск о 10:00.'), ['варто зазначити']);
});

test('slop phrases: word boundaries and inflected stems', () => {
  assert.deepEqual(findSlopPhrases('Він гуляв по сутінках.'), [], '«по суті» is not inside «по сутінках»');
  assert.deepEqual(findSlopPhrases('Це, по суті, рекорд.'), ['по суті']);
  assert.deepEqual(findSlopPhrases('Банк відіграв ключову роль.'), ['відіграв ключову роль']);
  assert.deepEqual(findSlopPhrases('Вони відіграли ключову роль.'), ['відіграли ключову роль']);
  assert.deepEqual(findSlopPhrases('NASA запустила телескоп 12 березня.'), []);
  assert.deepEqual(findSlopPhrases('Нова ера космосу.'), ['нова ера']);
  assert.deepEqual(findSlopPhrases('Нова ерагон-гра.'), []);
});

test('owner banned terms: substring as before, on the same normalisation', () => {
  assert.deepEqual(findBannedTerms('Ми пʼємо каву.', ["п'ємо"]), ["п'ємо"]);
  assert.deepEqual(findBannedTerms('Туманність Кільце', ['туманність']), ['туманність']);
  assert.deepEqual(findBannedTerms('Зоря', ['', '  ']), []);
});

// ── warnings ─────────────────────────────────────────────────────────────────

test('warning codes are slop_* and recognised', () => {
  for (const c of SLOP_WARNING_CODES) assert.ok(c.startsWith('slop_') && isSlopWarning(c));
  assert.equal(isSlopWarning('lead_missing'), false);
});

test('em-dash density: one per 400 chars passes, more warns', () => {
  assert.ok(!codes('Київ — столиця. Запуск перенесли на вівторок через погоду.').includes('slop_em_dash'));
  assert.ok(codes('Запуск — у вівторок. Причина — погода. Наступне вікно — четвер.').includes('slop_em_dash'));
  const long = `${'Ракету запустили з Флориди о десятій ранку за місцевим часом. '.repeat(19)}Київ — столиця. Львів — місто. Одеса — порт.`;
  assert.ok(long.length >= 1200 && !codes(long).includes('slop_em_dash'), 'three dashes in 1200+ chars are fine');
});

test('exclamation marks: one is fine, two warn', () => {
  assert.ok(!codes('Ракета злетіла! Старт о 10:00.').includes('slop_exclamation'));
  assert.ok(codes('Ракета злетіла! Це рекорд!').includes('slop_exclamation'));
  assert.ok(codes('Неймовірно!!').includes('slop_exclamation'));
});

test('rhetorical question answered in the next sentence', () => {
  assert.ok(rhetoricalQa('Що це означає? Компанія скоротить 300 людей.'));
  assert.ok(rhetoricalQa('Компанія звітувала. Результат? Мінус 12% виручки.'));
  assert.ok(rhetoricalQa('Чому так сталося? Постачальник зірвав терміни.'));
  assert.equal(rhetoricalQa('Компанія скоротить 300 людей. Що буде далі, поки невідомо.'), null);
  assert.equal(rhetoricalQa('Запуск перенесли на четвер. А ви полетіли б?'), null, 'a closing question to readers is not answered');
  assert.equal(rhetoricalQa('А ви як думаєте? Пишіть у коментарях.'), null, 'reader-directed questions are T3, not rhetorical');
  assert.ok(codes('Що це означає? Компанія скоротить 300 людей.').includes('slop_rhetorical_qa'));
});

test('moralising last sentence', () => {
  for (const s of [
    'Ракету запустили. Тож майбутнє вже тут.',
    'Ракету запустили. Отже, варто стежити за новинами.',
    'Ракету запустили. Памʼятайте: космос близько.',
    "Ракету запустили. Пам'ятайте про безпеку.",
    'Ракету запустили. У світі, де все змінюється, це важливо.',
    'Ракету запустили. Це показує, що галузь росте.',
  ]) assert.ok(moralCloser(s), s);
  assert.equal(moralCloser('Ракету запустили о 10:00. Наступний старт — 14 березня.'), null);
  assert.equal(moralCloser('Тож запуск перенесли. Новий старт — 14 березня.'), null, 'only the last sentence counts');
  assert.ok(codes('Ракету запустили. Тож чекаємо.').includes('slop_moral_closer'));
});

test('three-adjective lists', () => {
  assert.ok(adjectiveTriple('Це яскравий, сміливий і неймовірний проєкт.'));
  assert.ok(adjectiveTriple('Страва нова, смачна та корисна.'));
  assert.ok(adjectiveTriple('Нові, швидкі й тихі потяги.'));
  assert.ok(adjectiveTriple('Про яскравого, сміливого, неймовірного героя.'));
  assert.equal(adjectiveTriple('Київ, Львів і Одеса прийняли рейси.'), null);
  assert.equal(adjectiveTriple('Франція, Італія та Іспанія підписали угоду.'), null);
  assert.equal(adjectiveTriple('Купили каву, воду і їжу.'), null);
  assert.equal(adjectiveTriple('Яскравий і сміливий проєкт.'), null, 'two are fine');
});

test('emoji over format_prefs.emoji', () => {
  assert.ok(codes('Зоря 🌟 сяє.', { emoji: 'none' }).includes('slop_emoji_over_pref'));
  assert.ok(!codes('Зоря 🌟🌟 сяє.', { emoji: 'light' }).includes('slop_emoji_over_pref'));
  assert.ok(codes('Зоря 🌟🌟🌟🌟 сяє.', { emoji: 'light' }).includes('slop_emoji_over_pref'));
  assert.ok(!codes('Зоря 🌟🌟🌟🌟 сяє.').includes('slop_emoji_over_pref'), 'no pref: the card emojiPolicy decides');
});

test('humour and slang markers: warnings while off (default), silent once the owner allows them', () => {
  assert.ok(codes('Це кринж, ахаха 😂').includes('slop_humor_off'));
  assert.ok(codes('Це кринж, ахаха').includes('slop_slang_off'));
  assert.ok(codes('Реліз — імба, бро.').includes('slop_slang_off'));
  assert.ok(!codes('Це кринж, ахаха 😂', { humor: 'light', slang: true }).some((c) => c === 'slop_humor_off' || c === 'slop_slang_off'));
  assert.ok(codes('Це кринж.', { humor: 'light' }).includes('slop_slang_off'), 'humour on does not allow slang');
  // Plain news vocabulary is not slang.
  assert.deepEqual(codes('Краш-тест показав пʼять зірок. Чілі підписала угоду. База даних виросла до 2 млн записів.'), []);
  for (const m of [...HUMOR_MARKERS, ...SLANG_MARKERS]) assert.equal(normalizeSlop(m), m, `marker normalised: ${m}`);
});

test('a clean Ukrainian news post has no slop warnings', () => {
  const body = 'NASA відклала запуск місії Artemis III на вересень 2027 року. Причина — затримка з посадковим модулем SpaceX. '
    + 'Екіпаж із чотирьох астронавтів уже пройшов тренування в Х’юстоні. Наступний огляд графіка агентство проведе в березні.';
  assert.deepEqual(slopWarnings({ body }), []);
});

// ── wired into both lints ────────────────────────────────────────────────────

test('lintPost: banned phrase is an error, slop counters are warnings that do not fail the post', () => {
  const bad = lintPost(makeSpec({ body: [{ type: 'lead', text: 'Це невід’ємна частина космосу.' }] }), makeCard());
  assert.ok(bad.errors.some((e) => e.code === 'banned_term'));
  const soft = lintPost(makeSpec({ body: [{ type: 'lead', text: 'Туманність сяє! Її видно! Що це означає? Її сфотографував Webb.' }] }), makeCard());
  assert.equal(soft.ok, true, JSON.stringify(soft.errors));
  const w = soft.warnings.map((x) => x.code);
  assert.ok(w.includes('slop_exclamation') && w.includes('slop_rhetorical_qa'), JSON.stringify(w));
  const fun = lintPost(makeSpec({ body: [{ type: 'lead', text: 'Туманність — імба, ахаха.' }] }), makeCard());
  assert.ok(fun.ok && fun.warnings.some((x) => x.code === 'slop_humor_off'));
  const allowed = lintPost(makeSpec({ body: [{ type: 'lead', text: 'Туманність — імба, ахаха.' }] }), makeCard({ humor: 'light', slang: true }));
  assert.ok(!allowed.warnings.some((x) => x.code === 'slop_humor_off' || x.code === 'slop_slang_off'));
});

test('lintPlatformPost: same phrase list (normalised) and slop warnings with the resource voice', () => {
  const spec = (caption: string) => PlatformPostSpecSchema.parse({ format: 'th_text', title: 'Марс', caption });
  assert.ok(lintPlatformPost(spec('По суті, Марс червоний.'), { platform: 'threads' }).errors.some((e) => e.code === 'banned_phrase'));
  assert.ok(lintPlatformPost(spec("Це невід'ємна частина місії."), { platform: 'threads' }).errors.some((e) => e.code === 'banned_phrase'));
  const r = lintPlatformPost(spec('Марс видно сьогодні! І завтра! Це вайб.'), { platform: 'threads' });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'slop_exclamation') && r.warnings.some((w) => w.code === 'slop_slang_off'));
  const ok = lintPlatformPost(spec('Марс видно сьогодні. Це вайб.'), { platform: 'threads', voice: { slang: true } });
  assert.ok(!ok.warnings.some((w) => w.code === 'slop_slang_off'));
});
