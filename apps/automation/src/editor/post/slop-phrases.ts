/**
 * Spec 034 FR-003: the deterministic half of the `anti-slop` skill. Every
 * phrase here is a hard lint error in a reader-facing post (Telegram and the
 * other platforms share it). Phrases are stored normalised (`normalizeSlop`):
 * lowercase, every apostrophe as ʼ, no commas, single spaces. `*` inside a
 * phrase stands for the rest of a word (an inflected ending), so
 * «відігра* ключову роль» catches «відіграє / відіграла / відіграли ключову роль».
 * Matching is on word boundaries, so «по суті» does not fire inside «по сутінках».
 *
 * Only phrases that are AI tells in practically any context belong here; the
 * softer patterns (moral closers, rhetorical Q&A, three adjectives, em-dash
 * density, …) are warnings in slop-lint.ts and go to the critic (spec 034 T2).
 */
export const SLOP_PHRASES: readonly string[] = [
  // Signposting and empty emphasis
  'варто зазначити', 'слід зазначити', 'варто відзначити', 'слід відзначити', 'варто підкреслити', 'слід підкреслити',
  'важливо зазначити', 'важливо відзначити', 'важливо розуміти', 'важливо памʼятати', 'особливо важливо',
  'не можна не згадати', 'не можна не відзначити', 'як відомо', 'очевидно що', 'безумовно', 'звичайно ж',
  'не секрет що', 'ні для кого не секрет', 'без перебільшення', 'можна з упевненістю сказати', 'з упевненістю можна сказати',
  'не варто забувати', 'варто памʼятати', 'слід памʼятати',
  // Time-and-world framing
  'як ніколи раніше', 'у сучасному світі', 'в сучасному світі', 'в умовах сьогодення', 'за умов сьогодення',
  'на сьогоднішній день', 'у світі що постійно змінюється', 'у швидкоплинному світі', 'як ніколи актуальн*',
  // Significance and legacy puffery
  'це свідчить про', 'дане питання', 'з огляду на це',
  'знаменує поворотний момент', 'знаменує новий етап', 'поворотний момент в історії',
  'знакова подія', 'знаковою подією', 'знакову подію', 'віха в історії', 'віхою в історії', 'нова віха',
  'ширший тренд', 'ширшого тренду', 'частина ширшого руху', 'частиною ширшого руху', 'в контексті глобальної тенденції',
  'свідчення тривалого впливу', 'невідʼємн* частин*', 'глибоко вкорінен*', 'закладає основи для', 'формує ландшафт', 'визначає майбутнє',
  'відігра* ключову роль', 'відігра* вирішальну роль', 'відігра* важливу роль', 'гра* ключову роль', 'гра* важливу роль',
  'має вирішальне значення', 'займає центральне місце', 'змінює правила гри', 'змінить правила гри',
  'вивести на новий рівень', 'виводить на новий рівень', 'не залишить байдужим', 'не залишить байдужими', 'не залишить нікого байдужим',
  // Cinematic and announcing openers
  'уявіть собі', 'уявіть:', 'картина така:', 'ось сцена:', 'розберімось', 'розберімося', 'давайте розберемося', 'давайте розберемось',
  'погляньмо', 'давайте поглянемо', 'ось що потрібно знати', 'ось що варто знати', 'без зайвих слів', 'коротко про головне',
  'відкрийте для себе', 'пориньте у світ', 'поринути у світ', 'зануртеся у світ', 'зануритися у світ',
  // Wrap-ups
  'майбутнє виглядає яскравим', 'попереду цікаві часи', 'підсумовуючи', 'підсумуємо', 'у підсумку можна сказати',
  'отже можна зробити висновок', 'залишайтеся з нами', 'тримайте руку на пульсі',
  // Metaphors and hype
  'гарячий тренд', 'гаряче захоплення', 'на хвилі популярності', 'захоплююча подорож', 'захоплива подорож', 'нова ера',
  'світанок нової ери', 'незабутні враження',
  // Persuasive authority tropes
  'по суті', 'у своїй основі', 'насправді ж', 'справжнє питання', 'глибша проблема', 'суть справи в тому', 'що дійсно важливо',
  // Copula avoidance and participle tails
  'виступає як', 'являє собою', 'являють собою', 'стоїть як символ', 'може похвалитися', 'можуть похвалитися',
  'підкреслюючи', 'символізуючи',
  // Vague attribution and hedging
  'експерти вважають', 'експерти зазначають', 'спостерігачі зазначають', 'за словами експертів', 'галузеві звіти', 'низка джерел',
  'потенційно може', 'потенційно можуть', 'деякою мірою можливо', 'ймовірно мабуть',
  // Tailing fragments
  'без вгадування', 'без зайвих рухів',
  // Chatbot artefacts
  'звісно!', 'чудове питання', 'сподіваюся це допоможе', 'сподіваюсь це допоможе', 'ось огляд', 'нижче наведено',
  'якщо потрібно можу', 'на момент останнього оновлення', 'наскільки мені відомо', 'у цій статті', 'як штучний інтелект я',
  'як мовна модель', 'as an ai', 'as a language model', 'i hope this helps',
];

/** Apostrophes writers and models actually use for the Ukrainian ʼ. */
const APOSTROPHES = /[’'‘`ʹ′ʼ]/g;

/**
 * Text as the slop rules see it: lowercase, one apostrophe (ʼ), commas dropped
 * (so «очевидно, що» matches «очевидно що»), whitespace collapsed.
 */
export function normalizeSlop(text: string): string {
  return text.toLowerCase().replace(APOSTROPHES, 'ʼ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

const WORD = '[\\p{L}\\p{N}ʼ]';

/** A phrase as a word-bounded regex; `*` is the rest of a word. */
export function phraseRegex(phrase: string): RegExp {
  const body = phrase.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(`${WORD}*`);
  const startsWord = /^[\p{L}\p{N}]/u.test(phrase);
  const endsWord = /[\p{L}\p{N}*]$/u.test(phrase);
  return new RegExp(`${startsWord ? `(?<!${WORD})` : ''}${body}${endsWord ? `(?!${WORD})` : ''}`, 'u');
}

const COMPILED = SLOP_PHRASES.map((p) => ({ phrase: p, re: phraseRegex(p) }));

/** The banned phrases found in a text (as written in the text after normalisation), each once. */
export function findSlopPhrases(text: string): string[] {
  const t = normalizeSlop(text);
  const out: string[] = [];
  for (const { re } of COMPILED) {
    const m = t.match(re);
    if (m && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/**
 * The owner's own banned terms (card.bannedTerms): substring match as before,
 * on the same normalisation, so a term written with ' also catches ʼ and ’.
 */
export function findBannedTerms(text: string, terms: readonly string[]): string[] {
  const t = normalizeSlop(text);
  return terms.filter((term) => { const n = normalizeSlop(term); return n.length > 0 && t.includes(n); });
}
