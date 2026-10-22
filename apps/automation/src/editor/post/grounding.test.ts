/** Spec 037 T4: number normalisation, grounding against the pages read, and the critic's passages. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundNumbers, PASSAGE, postNumbers, sourcePassages, statisticalPercents } from './grounding';

const AT = { publishedAt: '2026-10-09T15:01:07Z', timezone: 'Europe/Kyiv' }; // 09.10 18:01 Kyiv
const values = (text: string) => postNumbers(text, AT).map((n) => [n.text, n.kind, n.value]);

test('normalisation: «1,05 трлн», «850 тисяч», «2 599», «$0.10», «−75%», «1 мільйона», «12B», «$14,5 млрд», dates', () => {
  assert.deepEqual(values('Модель має 1,05 трлн параметрів.'), [['1,05 трлн', 'count', 1.05e12]]);
  assert.deepEqual(values('Відгуки від понад 850 тисяч гравців.'), [['850 тисяч', 'count', 850_000]]);
  assert.deepEqual(values('Ціна 2 599 грн.'), [['2 599 грн', 'money', 2599]]);
  assert.deepEqual(values('Від $0.10 за мільйон токенів.'), [['$0.10', 'money', 0.1]]);
  assert.deepEqual(values('RDR2 −75% до неділі.'), [['75%', 'percent', 75]]);
  assert.deepEqual(values('до 1 мільйона токенів'), [['1 мільйона', 'count', 1e6]]);
  assert.deepEqual(values('Нова 12B модель'), [['12B', 'count', 12e9]]);
  assert.deepEqual(values('Залучила $14,5 млрд'), [['$14,5 млрд', 'money', 14.5e9]]);
  assert.deepEqual(values('Роздача до 15 жовтня, реліз 12.11'), [['15 жовтня', 'date', 1015], ['12.11', 'date', 1112]]);
  const approx = postNumbers('понад 850 тисяч гравців', AT)[0];
  assert.equal(approx.approx, true);
});

test('not claims: years, the post date, times, list numbering, versions, small bare integers, quoted examples', () => {
  assert.deepEqual(values('Термін запропонували в 1956 році; Sekiro GOTY 2019 року.'), []);
  assert.deepEqual(values('Сьогодні, 9 жовтня, о 18:00 за Києвом.'), [], 'the post date and a time');
  assert.deepEqual(values('1. Роль: скажіть, хто відповідає\n2. Контекст'), []);
  assert.deepEqual(values('Gemini 4 Argon, GPT-6, Qwen-Image-2.1-Turbo, Claude Haiku 5.5, Red Dead Redemption 2, Mellum2.1, iOS 26'), []);
  assert.deepEqual(values('5 термінів ШІ простими словами, 3 правила'), []);
  assert.deepEqual(values('Добре: «Мені 35, вага 80 кг, хочу схуднути на 5 кг за 2 місяці»'), []);
  assert.deepEqual(values('Цього достатньо для 90% побутових задач'), [['90%', 'percent', 90]]);
});

test('statisticalPercents: a claim about the world, not a discount', () => {
  assert.deepEqual(statisticalPercents('Цього достатньо для 90% побутових задач', AT).map((n) => n.value), [90]);
  assert.deepEqual(statisticalPercents('Знижка 20% до неділі; RDR2 −75%; ще 50% off', AT), []);
});

const STEAM = 'Red Dead Redemption 2 · ₴649 (was ₴2,599) -75% · Overwhelmingly Positive · 850,123 user reviews · Offer ends October 15. '
  + 'Mistral Large 4 has 1.05T parameters; pricing from $0.10 per million input tokens. Terraria: 1,234,567 reviews.';

test('grounding: synthetic sources that contain the numbers give no false number_not_in_sources', () => {
  const post = 'RDR2 — 649 грн замість 2 599 грн (−75%), понад 850 тисяч відгуків, роздача до 15 жовтня. '
    + 'Mistral Large 4 має 1,05 трлн параметрів і коштує від $0.10 за мільйон. Terraria — понад 1,2 млн відгуків.';
  const g = groundNumbers(post, [{ url: 'https://store.steampowered.com/app/1174180', text: STEAM }], AT);
  assert.equal(g.checked, true);
  assert.deepEqual(g.missing.map((n) => n.text), []);
  assert.equal(g.found.length, 8);
});

test('grounding: a number on no page read is missing; a percent needs a percent; no source text → not checked', () => {
  const g = groundNumbers('Знижка 70%: 539 грн замість 1799. Понад 80% контенту Netflix підбирає алгоритм.', [{ url: 'u', text: STEAM }], AT);
  assert.deepEqual(g.missing.map((n) => n.text), ['70%', '539 грн', '1799', '80%']);
  assert.deepEqual(groundNumbers('Ціна 649 грн', [{ url: 'u', text: 'about 649 visitors and 75 more' }], AT).missing, []);
  assert.deepEqual(groundNumbers('75% відгуків', [{ url: 'u', text: 'only 75 reviews' }], AT).missing.map((n) => n.text), ['75%']);
  const none = groundNumbers('Понад 80% контенту', [{ url: 'u', text: null }, { url: 'v' }], AT);
  assert.deepEqual([none.checked, none.missing.length], [false, 0]);
  // Ukrainian forms in a Ukrainian source; English thousands and words.
  assert.deepEqual(groundNumbers('68,90% у рейтингу, 3 млрд', [{ url: 'u', text: 'результат 68,90% і 3 billion' }], AT).missing, []);
  assert.deepEqual(groundNumbers('1 мільйона токенів', [{ url: 'u', text: 'a 1M-token context window' }], AT).missing, []);
});

test('passages: ±400 chars around the post\'s numbers and names, not the page head; ≤ 6 passages, ≤ 6000 chars', () => {
  const head = 'Menu Home News Deals Login. '.repeat(200); // 5400 chars of navigation
  const fact = 'Google said Gemini 4 Argon accepts a 1M-token context window, while a single response is capped at 64K output tokens.';
  const page = `${head}${fact} ${'Filler sentence about something else. '.repeat(100)}`;
  const ps = sourcePassages('Модель пише тексти довжиною до 1 мільйона токенів. Gemini 4 Argon вже в API.', [{ url: 'https://m.example/a', text: page }], AT);
  assert.equal(ps.length, 1);
  assert.match(ps[0].text, /1M-token context window, while a single response is capped at 64K output tokens/);
  assert.ok(ps[0].text.length <= 2 * PASSAGE.radius + fact.length + 2, `${ps[0].text.length}`);
  assert.ok(!ps[0].text.includes('Menu Home News Deals Login. '.repeat(20)), 'not the page head');
  assert.deepEqual(ps[0].about, ['1 мільйона', 'Gemini 4 Argon']);

  // Many claims far apart: at most 6 passages and 6000 chars.
  const far = Array.from({ length: 10 }, (_, i) => `${'x '.repeat(600)}Item ${i}: price ${100 + i} UAH.`).join(' ');
  const many = sourcePassages(Array.from({ length: 10 }, (_, i) => `ціна ${100 + i} грн`).join(', '), [{ url: 'u', text: far }], AT);
  assert.equal(many.length, PASSAGE.max);
  assert.ok(many.reduce((n, p) => n + p.text.length, 0) <= PASSAGE.chars + 2 * PASSAGE.max);
  assert.deepEqual(sourcePassages('Нічого спільного', [{ url: 'u', text: page }], AT), []);
});

test('037 grounding: «4 центи» is money ($0.04) and matches "$0.04 per million"; «262 тисяч» matches "262K"', () => {
  const post = 'Jev 1.14 читає 262 тисяч слів і коштує 4 центи за мільйон токенів.';
  const nums = postNumbers(post);
  assert.deepEqual(nums.map((n) => [n.text, n.kind]), [['262 тисяч', 'count'], ['4 центи', 'money']]);
  assert.ok(Math.abs(nums[1].value - 0.04) < 1e-9);
  const r = groundNumbers(post, [{ url: 'https://x.dev/jev', text: 'A 262K-word context at $0.04 per million tokens.' }]);
  assert.deepEqual(r.missing.map((m) => m.text), []);
  assert.deepEqual(groundNumbers(post, [{ url: 'u', text: 'At $0.40 per million tokens.' }]).missing.map((m) => m.text), ['262 тисяч', '4 центи']);
});

test('046: thousands separators, ranges, compound words and enumerations are not false misses', () => {
  const miss = (post: string, src: string) => groundNumbers(post, [{ url: 'u', text: src }]).missing.map((n) => n.text);
  assert.deepEqual(miss('Ядер CUDA: 5,120 у новій картці.', 'The card has 5120 CUDA cores.'), [], '«5,120» also reads as 5120');
  assert.deepEqual(miss('Роздільність 3,552x3,840 на око.', 'Resolution of 3552 x 3840 per eye.'), []);
  assert.deepEqual(miss('Ціна — $2,599.99 за базову версію.', 'Base price is $2599.99.'), []);
  assert.deepEqual(miss('Ціна 1.299,50 € у Німеччині.', 'Kostet 1299,50 Euro.'), []);
  assert.deepEqual(miss('Процесор на 18‑core з частотою 5.2 ГГц.', 'An 18-core CPU at 5.2 GHz.'), [], 'U+2011 hyphen');
  assert.deepEqual(miss('Від 20–30 тисяч гривень за пристрій.', 'Prices from 20000 to 30000 UAH.'), [], 'the range start takes the scale');
  assert.deepEqual(miss('Від 20–30 млн користувачів.', 'Between 20 and 30 million users.'), []);
  assert.deepEqual(miss('Версії 1,2,3 вже вийшли.', 'Versions out.'), [], 'an enumeration is not a decimal');
  assert.deepEqual(miss('Податок 25 тисяч гривень.', 'Tax 7 UAH.'), ['25 тисяч гривень'], 'a real miss stays a miss');
  const n = postNumbers('Ядер CUDA: 5,120.')[0];
  assert.deepEqual([n.value, n.alt?.map((a) => a.value)], [5.12, [5120]]);
});

test('063 FR-001: spelled scales («$1 млрд» = "over a billion dollars"), bill names, separators and written-out percents', () => {
  const miss = (post: string, src: string) => groundNumbers(post, [{ url: 'u', text: src }]).missing.map((n) => n.text);
  // Review 3, slot 11d73ed6: the TechCrunch text spells both out.
  const tc = 'The startup, which has raised over a billion dollars, backed Senate Bill 53 in California.';
  assert.deepEqual(miss('Стартап залучив понад $1 млрд і підтримав SB 53.', tc), []);
  assert.deepEqual(miss('Стартап залучив $1B.', 'It raised one billion dollars.'), []);
  assert.deepEqual(miss('Залучили 2 мільярди.', 'It raised two billion.'), []);
  assert.deepEqual(miss('Залучили 5 млн.', 'It raised a billion dollars.'), ['5 млн'], 'a real miss stays a miss');
  assert.deepEqual(miss('Підтримали SB 54.', tc), ['SB 54'], 'another bill number is a miss');
  assert.deepEqual(miss('Закон AB 1018 у Каліфорнії.', 'Assembly Bill 1018 passed.'), []);
  assert.deepEqual(miss('Закон SB53 підписано.', 'S.B. 53 was signed.'), []);
  assert.deepEqual(miss('Закон Senate Bill 53 підписано.', 'The bill, SB 53, was signed.'), []);
  assert.equal(postNumbers('Законопроєкт SB 53 підписано.')[0].kind, 'bill');
  assert.deepEqual(postNumbers('Законопроєкт SB 53 підписано.').map((n) => n.text), ['SB 53']);
  // Percent: digits, words, «відсотків».
  assert.deepEqual(miss('Зросло на 40%.', 'Sales grew 40 percent.'), []);
  assert.deepEqual(miss('Зросло на 40 відсотків.', 'Sales grew forty percent.'), []);
  assert.deepEqual(miss('Зросло на 55%.', 'Sales grew fifty-five per cent.'), []);
  assert.deepEqual(miss('Зросло на 45%.', 'Sales grew forty percent.'), ['45%']);
  // Review 2: separators and compounds stay no false positives.
  assert.deepEqual(miss('Ядер CUDA: 5 120.', 'The card has 5,120 CUDA cores.'), []);
  assert.deepEqual(miss('Ядер CUDA: 5,120.', 'The card has 5120 CUDA cores.'), []);
  assert.deepEqual(miss('Ціна $2,599.99, 18-core, 3,552x3,840.', 'Priced at $2599.99. An 18-core chip with 3552 x 3840 pixels.'), []);
});

test('063 FR-001: the critic passages find the sentence that spells a number or a bill out', () => {
  const page = `${'Filler. '.repeat(300)}The startup has raised over a billion dollars and backed Senate Bill 53. ${'More filler. '.repeat(300)}`;
  const ps = sourcePassages('Стартап залучив $1 млрд і підтримав SB 53.', [{ url: 'u', text: page }], AT);
  assert.equal(ps.length, 1);
  assert.match(ps[0].text, /over a billion dollars and backed Senate Bill 53/);
  assert.deepEqual(ps[0].about, ['$1 млрд', 'SB 53']);
});
