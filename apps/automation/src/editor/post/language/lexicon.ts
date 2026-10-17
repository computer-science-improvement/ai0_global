/**
 * Spec 041 FR-001 (T1): a deterministic Ukrainian language gate — russisms and calques, a suspect case, contested
 * calques and the у/в, і/й alternation. Phrase and regex based (no morphology): what it cannot see, the critic's
 * required `language` axis covers.
 *
 *   language_calque   error    an unambiguous russism / calque («приймати участь», «на протязі», «являється»)
 *   language_case     warning  a suspect case («трапляється у найвідоміших сервісів» → «з …ими»)
 *   language_suspect  warning  a contested or context-dependent calque («вражаючий», «на борту» outside a vehicle)
 *   language_euphony  warning  у/в, і/й against the alternation rule, with the exact replacement (`fix`)
 *
 * Every pattern runs on the lowercased text with apostrophes unified, so match offsets map back to the original.
 */

export type LanguageCode = 'language_calque' | 'language_case' | 'language_suspect' | 'language_euphony';
export const LANGUAGE_CODES: readonly LanguageCode[] = ['language_calque', 'language_case', 'language_suspect', 'language_euphony'];

export interface LanguageFinding {
  code: LanguageCode;
  level: 'error' | 'warning';
  message: string;
  /** The words as written in the post. */
  excerpt: string;
  /** An exact replacement code may apply without a new LLM turn (euphony only). */
  fix?: { from: string; to: string };
}

interface Entry { re: string; use: string; code?: LanguageCode }

const L = '[\\p{L}ʼ]';
/** Word edges: a letter, an apostrophe or a hyphen continue the word. */
const B = `(?<![\\p{L}ʼ-])`;
const E = `(?![\\p{L}ʼ])`;
/** Case endings of an adjective / participle (not the -и of a gerund: «працюючи» is fine). */
const ADJ_END = '(?:ий|ого|ому|им|их|ими|ої|ій|ою|ую|а|е|і|у)';

/** Unambiguous russisms and calques (errors): the pattern and the word to use. */
export const CALQUES: readonly Entry[] = [
  { re: `(?:прийма|прийня|прийму|приймі|прийми)${L}*\\s+участ${L}*`, use: 'брати участь' },
  { re: `на\\s+протязі`, use: 'протягом, упродовж' },
  { re: `слідуюч${L}*`, use: 'наступний' },
  { re: `явля(?:ється|ються|вся|лася|лося|лись|лися)`, use: '«є» (або «стає», «виступає»)' },
  { re: `заточен${ADJ_END}(?!\\s+(?:ніж|лезо|олів|меч|сокир))`, use: 'налаштований на, розрахований на, орієнтований на' },
  { re: `[ув]\\s+якості(?!\\s+(?:звуку|зображення|картинки|відео|продукт|товар|сигналу|звʼязку))`, use: '«як» (у ролі)' },
  { re: `співпа(?:да|ла|ли|в|де|дуть|дає|дають|сти)${L}*`, use: 'збігатися' },
  { re: `сам(?:ий|ого|ому|им|их|ими|а|ої|ій|ою|е|і)\\s+(?:кращ|гірш|більш|менш|велик|мал|популярн|відом|сильн|швидк|дешев|дорог|важлив|цікав|потужн|головн|перш|остан|нов|стар)${L}*`, use: 'форма з «най-» («найкращий»)' },
  { re: `на\\s+рахунок\\s+(?:того|цього|цієї|цих|них|нього|неї|мене|тебе|вас|нас)`, use: 'щодо' },
  { re: `[ув]\\s+відповідності\\s+(?:з|із|до)`, use: 'відповідно до' },
  { re: `(?:прийма|прийня|прийму)${L}*\\s+(?:міри|мір)`, use: 'вжити заходів' },
  { re: `міроприємств${L}*`, use: 'захід' },
  { re: `співстав${L}*`, use: 'зіставляти' },
  { re: `по\\s+відношенню\\s+до`, use: 'щодо' },
  { re: `(?:працююч|оточуюч|бажаюч|початкуюч|відповідаюч|завершаюч|наступаюч)${ADJ_END}`, use: 'не дієприкметник на -уч-/-юч-: «що працює», «довколишній», «охочі», «початківець»' },
  { re: `вибачаю(?:сь|ся)`, use: 'перепрошую, вибачте' },
];

/** Suspect case (warning): «трапляється у X-их» — with whom it happens is «з + орудний». */
export const CASE_SUSPECTS: readonly Entry[] = [
  { re: `(?:трапля|буває|бувал|стається|стала|стало|сталося|трапил)${L}*\\s+(?:навіть\\s+|і\\s+|й\\s+)?[ув]\\s+${L}+(?:их|ів|ей)${E}`, use: '«з ким»: «трапляється навіть з найвідомішими сервісами»' },
];

/** Contested or context-dependent calques (warnings for the critic). */
export const SUSPECTS: readonly Entry[] = [
  { re: `вражаюч${ADJ_END}`, use: 'приголомшливий, разючий, вражений' },
  { re: `існуюч${ADJ_END}`, use: 'наявний, чинний' },
  { re: `з\\s+точки\\s+зору`, use: 'з погляду' },
  { re: `дякуючи\\s+(?!вам|тобі|всім|усім|вс|ус)`, use: 'завдяки (дякуючи — лише «кажучи дякую»)' },
  { re: `на\\s+борту(?!\\s+(?:літак|судн|корабл|човн|яхт|станці|мкс|ракет|лайнер|авіалайнер|апарат|космічн|субмарин|поїзд|вертольот|гелікоптер|дрон|автомобіл|автобус))`, use: 'поза транспортом «на борту» — калька: «на боці», «із зображенням», «має»' },
  { re: `(?:їха|виїха|заїха|проїха|з'їха|зʼїха|руха|коти|покоти|скоти|біг|збіг|йшл|пройш|зійш|ковза|спуска|підійма|піднял|підніма|лет|злет|пролет)${L}*\\s+по\\s+${L}+(?:ій|ому|им|ах|ях|і)\\s+${L}+(?:і|у|ю|ах|ях)${E}`, use: 'шлях руху — орудним відмінком: «рампою», «дорогою», «сходами»' },
];

/** Phrases that look like a finding but are right in context (normalised, lowercase). */
export const LEXICON_EXCEPTIONS: readonly string[] = [
  'на борту літака', 'на борту мкс', 'у якості звуку', 'в якості звуку', 'по суті',
];

const VOWELS = 'аеєиіїоуюя';
const isVowel = (c: string | undefined) => !!c && VOWELS.includes(c.toLowerCase());
const isConsonant = (c: string | undefined) => !!c && /[бвгґджзйклмнпрстфхцчшщь]/i.test(c);
const isCyrillicWord = (w: string) => /^[а-яіїєґʼ]+$/i.test(w);
/** An acronym («ЄС», «США»): letters are named, not read, so the alternation does not apply. */
const isAcronym = (w: string) => w.length > 1 && w === w.toUpperCase();

/** Lowercase with the apostrophes unified to ʼ; same length as the input, so offsets map back. */
export function normalizeLang(text: string): string {
  return text.toLowerCase().replace(/['’`]/g, 'ʼ');
}

const compiled = (list: readonly Entry[]) => list.map((e) => ({ ...e, rx: new RegExp(`${B}${e.re}${E}`, 'gu') }));
const CALQUE_RX = compiled(CALQUES);
const CASE_RX = compiled(CASE_SUSPECTS);
const SUSPECT_RX = compiled(SUSPECTS);

function excepted(norm: string, at: number, len: number): boolean {
  const around = norm.slice(Math.max(0, at - 20), at + len + 30);
  const hit = norm.slice(at, at + len);
  return LEXICON_EXCEPTIONS.some((x) => around.includes(x) && (x.includes(hit) || hit.includes(x)));
}

function phraseFindings(text: string, norm: string): LanguageFinding[] {
  const out: LanguageFinding[] = [];
  const seen = new Set<string>();
  const run = (list: typeof CALQUE_RX, code: LanguageCode, level: 'error' | 'warning', what: string) => {
    for (const e of list) {
      for (const m of norm.matchAll(e.rx)) {
        if (excepted(norm, m.index!, m[0].length)) continue;
        const excerpt = text.slice(m.index!, m.index! + m[0].length);
        const key = `${code}:${excerpt.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ code, level, excerpt, message: `${what}: «${excerpt}» — ${e.use}` });
      }
    }
  };
  run(CALQUE_RX, 'language_calque', 'error', 'русизм / калька');
  run(CASE_RX, 'language_case', 'warning', 'підозрілий відмінок');
  run(SUSPECT_RX, 'language_suspect', 'warning', 'можлива калька');
  return out;
}

/**
 * У/в and і/й (the alternation rule), only where the case is clear:
 *   - sentence start: «У» before a vowel → «В»; «В» before a consonant → «У»;
 *   - between vowels: «у» → «в» (the previous word ends with a vowel, one space on each side, no punctuation);
 *   - between consonants: «в» → «у»; before в / ф always «у» («у вівторок»);
 *   - «й» before ї, й, є, ю, я (an iotated sound) → «і»; «Й» at a sentence start → «І».
 * The next word must be a Cyrillic word that is not an acronym. Each finding carries the exact replacement of the
 * three words (previous word, preposition, next word) or two at a sentence start.
 */
export function euphonyFindings(text: string): LanguageFinding[] {
  const out: LanguageFinding[] = [];
  const re = /(^|[.!?…:]\s+|\n\s*|(?<=[\p{L}ʼ]+)(\s))([УуВвЙй])\s+([\p{L}ʼ]+)/gu;
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const prep = m[3];
    const next = m[4];
    if (!isCyrillicWord(next) || isAcronym(next)) continue;
    const startOfSentence = m[2] === undefined;
    const prevWord = startOfSentence ? '' : /([\p{L}ʼ]+)$/u.exec(text.slice(0, m.index!))?.[1] ?? '';
    const prevLast = prevWord.slice(-1);
    const nextFirst = next[0];
    const low = prep.toLowerCase();
    let to: string | null = null;
    if (low === 'у' || low === 'в') {
      if (startOfSentence) {
        if (low === 'у' && isVowel(nextFirst)) to = 'в';
        else if (low === 'в' && isConsonant(nextFirst)) to = 'у';
      } else if (low === 'в' && /[вф]/i.test(nextFirst)) {
        to = 'у';
      } else if (low === 'у' && isVowel(prevLast) && isVowel(nextFirst)) {
        to = 'в';
      } else if (low === 'в' && isConsonant(prevLast) && prevLast.toLowerCase() !== 'й' && isConsonant(nextFirst)) {
        to = 'у';
      }
    } else if (low === 'й') {
      if (/[їйєюя]/i.test(nextFirst) || startOfSentence) to = 'і';
    }
    if (!to) continue;
    const toCased = prep === prep.toUpperCase() ? to.toUpperCase() : to;
    const from = startOfSentence ? `${prep} ${next}` : `${prevWord} ${prep} ${next}`;
    const repl = startOfSentence ? `${toCased} ${next}` : `${prevWord} ${toCased} ${next}`;
    if (seen.has(from)) continue;
    seen.add(from);
    const why = low === 'й' ? '«і» перед ї, й, є, ю, я та на початку речення'
      : to === 'в' ? '«в» перед голосним після голосного або на початку речення'
        : '«у» між приголосними, перед в/ф і на початку речення перед приголосним';
    out.push({ code: 'language_euphony', level: 'warning', excerpt: from, message: `милозвучність: «${from}» → «${repl}» (${why})`, fix: { from, to: repl } });
  }
  return out;
}

/** Every language finding of a text (the reader text of a post). */
export function languageFindings(text: string): LanguageFinding[] {
  if (!/[а-яіїєґ]/i.test(text)) return [];
  return [...phraseFindings(text, normalizeLang(text)), ...euphonyFindings(text)];
}
