import { test } from 'node:test';
import assert from 'node:assert/strict';
import { euphonyFindings, languageFindings } from './lexicon';
import { slopWarnings } from '../slop-lint';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';

const codes = (t: string) => languageFindings(t).map((f) => `${f.code}:${f.excerpt}`);

test('calques and russisms are errors with the Ukrainian word in the message', () => {
  assert.deepEqual(codes('Він приймав участь у турнірі на протязі тижня.'), ['language_calque:приймав участь', 'language_calque:на протязі']);
  assert.deepEqual(codes('Це являється проблемою. Слідуючий крок.'), ['language_calque:Слідуючий', 'language_calque:являється']);
  assert.deepEqual(codes('рівень під це заточений.'), ['language_calque:заточений']);
  assert.deepEqual(codes('Він виступив в якості експерта. Самий кращий результат.'), ['language_calque:в якості', 'language_calque:Самий кращий']);
  assert.deepEqual(codes('На рахунок цього домовились у відповідності з законом.'), ['language_calque:На рахунок цього', 'language_calque:у відповідності з']);
  assert.match(languageFindings('Дати співпадають.')[0].message, /збігатися/);
  assert.equal(languageFindings('Працюючий застосунок.')[0].code, 'language_calque');
});

test('right usages are not findings', () => {
  for (const t of [
    'Працюючи над цим, команда зʼявляється в офісі рано.',
    'Добре заточений ніж ріже папір.',
    'На борту літака було 150 пасажирів.',
    'Кошти надійдуть на рахунок у банку.',
    'Якість звуку покращили, у якості звуку різниця помітна.',
    'Вони взяли участь у турнірі протягом тижня.',
    'Код можуть використовувати й інші команди.',
    'В Україні тепло, а в інших країнах холодно.',
    'Він у Apple, вона у ЄС.',
    'Ще 3 моделі вийшли у 2026 році.',
  ]) assert.deepEqual(codes(t), [], t);
});

test('the review-2 defects are flagged (1713, 1714, 1715, 1719, 1721)', () => {
  assert.deepEqual(codes('Таке трапляється навіть у найвідоміших сервісів: ChatGPT назвав статтю.'), ['language_case:трапляється навіть у найвідоміших']);
  assert.deepEqual(codes('Ідея проста, і рівень під це заточений.'), ['language_calque:заточений']);
  assert.deepEqual(codes('«Керамічний гурток з чорним горобцем на борту стоїть на підвіконні»'), ['language_suspect:на борту']);
  assert.deepEqual(codes('авто виїхало по перевернутій рампі, розвернулося й приземлилося.'), ['language_suspect:виїхало по перевернутій рампі']);
  assert.deepEqual(codes('Огляд показав приріст. У інших видах завдань покращення менші.'), ['language_euphony:У інших']);
});

test('euphony: у/в and і/й with the exact replacement', () => {
  const fix = (t: string) => euphonyFindings(t).map((f) => f.fix && `${f.fix.from} → ${f.fix.to}`);
  assert.deepEqual(fix('У інших видах.'), ['У інших → В інших']);
  assert.deepEqual(fix('В Києві тепло.'), ['В Києві → У Києві']);
  assert.deepEqual(fix('Ми працюємо в вівторок.'), ['працюємо в вівторок → працюємо у вівторок']);
  assert.deepEqual(fix('Кіт в домі.'), ['Кіт в домі → Кіт у домі']);
  assert.deepEqual(fix('Вона у інших.'), ['Вона у інших → Вона в інших']);
  assert.deepEqual(fix('Він й його брат.'), ['Він й його → Він і його']);
  assert.deepEqual(fix('Й навіть так.'), ['Й навіть → І навіть']);
  // After a comma, a consonant before «в», a vowel after «у»-less contexts: left alone.
  assert.deepEqual(fix('Тепло, у інших країнах холодно. Він в Одесі.'), []);
});

test('domain slang (gaming, IT) is slop_slang_off unless format_prefs.slang is on', () => {
  const t = 'Steam ділить ачівки на набори: синґл окремо. Юзери отримали апдейт і нову фічу.';
  const off = slopWarnings({ body: t, prefs: {} }).find((w) => w.code === 'slop_slang_off');
  assert.ok(off);
  assert.match(off!.message, /ачівки.*синґл.*юзери.*апдейт.*фічу/);
  assert.equal(slopWarnings({ body: t, prefs: { slang: true } }).find((w) => w.code === 'slop_slang_off'), undefined);
  // Plain words that only look like slang.
  assert.equal(slopWarnings({ body: 'Новий сингл гурту вийшов. Каток відкрили.', prefs: {} }).find((w) => w.code === 'slop_slang_off'), undefined);
});

test('lintPost: a calque blocks the post, euphony is a warning with a fix; non-Ukrainian cards are not checked', () => {
  const spec = makeSpec({ body: [{ type: 'lead', text: 'Команда приймала участь у хакатоні' }, { type: 'p', text: 'Огляд показав приріст. У інших видах менше.' }] });
  const r = lintPost(spec, makeCard());
  assert.ok(r.errors.some((e) => e.code === 'language_calque'));
  const eu = r.warnings.find((w) => w.code === 'language_euphony');
  assert.deepEqual(eu?.fix, { from: 'У інших', to: 'В інших' });
  const en = lintPost(spec, makeCard({ language: 'en' }));
  assert.ok(!en.errors.some((e) => e.code === 'language_calque'));
});
