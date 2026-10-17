import { normalizeSlop, phraseRegex } from '../slop-phrases';
import { glossaryEntries, type ResourceStyle } from './resource-style';

/**
 * Spec 037 FR-008 (T8): the deterministic rules of the resource style sheet, as pure functions of a text and the
 * effective style. The integrity checks (integrity/checks/style-*.ts) and the platform lint (lintPlatformPost) share
 * them. Every rule is conservative: what it cannot tell apart (an adjective in -ите, a product called «Grace
 * Blackwell», a model name «Saluki 27B») it leaves alone.
 */

export interface StyleFinding { code: string; level: 'error' | 'warning'; message: string; excerpt?: string }

const L = '[\\p{L}ʼ]';
const URL_RE = /https?:\/\/\S+|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|ua|dev|app|co)(?:\/\S*)?/giu;
/** Quoted speech is somebody else's words: «…», „…“, “…”, "…" (one line). */
const QUOTED = /«[^«»\n]*»|„[^“”\n]*[“”]|“[^”\n]*”|"[^"\n]*"/gu;
const APOS = /[’'‘`ʹ′]/g;

const stripUrls = (t: string) => t.replace(URL_RE, ' ');

// ── address: ти / ви ─────────────────────────────────────────────────────────

const TY_PRONOUNS = new Set(['ти', 'тебе', 'тобі', 'тобою', 'твій', 'твоя', 'твоє', 'твої', 'твого', 'твоєї', 'твоєму', 'твоїй', 'твоїм', 'твоїх', 'твоїми']);
const VY_PRONOUNS = new Set(['ви', 'вас', 'вам', 'вами', 'ваш', 'ваша', 'ваше', 'ваші', 'вашого', 'вашої', 'вашому', 'вашій', 'вашим', 'ваших', 'вашими']);
/** 2nd person singular present / future: «граєш», «можеш», «робиш», «висаджуєшся». */
const TY_VERB = /^[\p{L}ʼ]{2,}(?:єш|еш|иш|їш)(?:ся)?$/u;
/** Singular imperatives of the -ай / -яй / -уй type: «забирай», «перевіряй», «голосуй», «признавайся». */
const TY_IMPERATIVE = /^[\p{L}ʼ]{3,}(?:ай|яй|уй|юй)(?:ся)?$/u;
/** Common singular imperatives without a regular ending. */
const TY_WORDS = new Set([
  'напиши', 'знайди', 'покажи', 'зроби', 'перевір', 'обери', 'вибери', 'візьми', 'глянь', 'натисни', 'тисни', 'підпишись',
  'заходь', 'переходь', 'встигни', 'забери', 'збережи', 'поділись', 'залиш', 'дивись', 'подивись', 'купи', 'запусти',
  'встанови', 'відкрий', 'спробуй', 'уяви', 'скажи', 'розкажи', 'признавайся',
]);
/** 2nd person plural / polite: «граєте», «заходите», «здогадаєтеся», «логінитесь». */
const VY_VERB = /^[\p{L}ʼ]{2,}(?:ете|єте|ите|їте)(?:ся|сь)?$/u;
/** Plural imperatives: «забирайте», «увімкніть», «будьте», «остерігайтеся», «підставте». */
const VY_IMPERATIVE = /^[\p{L}ʼ]{2,}(?:йте|іть|ьте|вте)(?:ся|сь)?$/u;
const VY_WORDS = new Set(['перевірте', 'повірте']);
/** Words with those endings that are not 2nd person verbs (nouns, adjectives, participles, particles). */
const NOT_ADDRESS = new Set([
  'відкрите', 'закрите', 'вкрите', 'покрите', 'розлите', 'вбите', 'вмите', 'прожите', 'забите', 'пробите', 'розбите', 'добите',
  'шите', 'зшите', 'вжите', 'навіть', 'століть', 'десятиліть', 'тисячоліть', 'бангладеш', 'маракеш', 'фетиш', 'кишмиш',
  'китай', 'урожай', 'врожай', 'звичай', 'трамвай', 'самурай', 'водограй', 'розмай', 'небокрай', 'шанхай', 'дубай', 'мумбай',
  'парагвай', 'уругвай', 'нехай', 'спотифай', 'вайфай', 'поцілуй', 'негідяй',
  // Spec 041 FR-006: adverbs and particles in -ай (review 2: «зазвичай» read as «ти»).
  'зазвичай', 'звичайно', 'вкрай', 'украй', 'край', 'бодай', 'мабуть', 'хай', 'гай', 'окрай', 'скрай', 'відчай', 'розпач',
]);

/** Neuter participles in -ите («перекрите», «залите»), not «ви» forms. */
const PARTICIPLE = /(?:крите|лите|шите|жите|гните)$/u;
/** What may stand before the first word of a sentence (a line break, an emoji, a bullet, end punctuation). */
const SENTENCE_START = /(?:^|[.!?…:;•\-—–(\n\p{Extended_Pictographic}])\s*$/u;

/** Words shorter than this are never verb forms here («кеш», «даєш» is the price of it). */
const MIN_VERB = 5;

export interface AddressForms { ty: string[]; vy: string[] }

/**
 * The 2nd person forms of a text (quoted speech, links and hashtags removed): pronouns, present / future verb forms
 * and imperatives. A capitalised word inside a sentence is a name and is skipped.
 */
export function addressForms(text: string): AddressForms {
  const clean = stripUrls(text).replace(QUOTED, ' … ').replace(/#[\p{L}\p{N}_]+/gu, ' ').replace(APOS, 'ʼ');
  const out: AddressForms = { ty: [], vy: [] };
  const re = new RegExp(`${L}+`, 'gu');
  for (const m of clean.matchAll(re)) {
    const word = m[0];
    const w = word.toLowerCase();
    const sentenceStart = SENTENCE_START.test(clean.slice(0, m.index));
    if (word[0] !== w[0] && !sentenceStart && !VY_PRONOUNS.has(w)) continue; // a name mid-sentence («Бангладеш»); «Ви» stays
    if (NOT_ADDRESS.has(w) || PARTICIPLE.test(w)) continue;
    if (TY_PRONOUNS.has(w) || TY_WORDS.has(w)) { out.ty.push(word); continue; }
    if (VY_PRONOUNS.has(w) || VY_WORDS.has(w)) { out.vy.push(word); continue; }
    if (w.length < MIN_VERB) continue;
    if (TY_VERB.test(w) || TY_IMPERATIVE.test(w)) out.ty.push(word);
    else if (VY_VERB.test(w) || VY_IMPERATIVE.test(w)) out.vy.push(word);
  }
  return out;
}

const FORM_UK = { ty: '«ти»', vy: '«ви»' } as const;
const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 3).join(', ');

/**
 * `address_mixed`: an error when one post addresses the reader both on «ти» and on «ви» (whatever the style); a
 * warning when it uses a form other than the resource's (`style.address`; `impersonal` = no form at all). Without a
 * style only the mix is checked.
 */
export function addressFindings(text: string, style: ResourceStyle | null | undefined): StyleFinding[] {
  const f = addressForms(text);
  if (f.ty.length && f.vy.length) {
    return [{
      code: 'address_mixed', level: 'error',
      message: `звертання змішане: ${FORM_UK.ty} (${uniq(f.ty)}) і ${FORM_UK.vy} (${uniq(f.vy)}) в одному пості — ${style?.address === 'ty' ? 'тримай «ти»' : style?.address === 'impersonal' ? 'пиши безособово' : 'тримай «ви»'}`,
      excerpt: `${f.ty[0]} / ${f.vy[0]}`,
    }];
  }
  const used = f.ty.length ? 'ty' : f.vy.length ? 'vy' : null;
  const want = style?.address;
  if (!used || !want || used === want) return [];
  const words = used === 'ty' ? f.ty : f.vy;
  return [{
    code: 'address_mixed', level: 'warning',
    message: want === 'impersonal'
      ? `ресурс пише безособово, а пост звертається на ${FORM_UK[used]} (${uniq(words)})`
      : `ресурс звертається на ${FORM_UK[want]}, а пост — на ${FORM_UK[used]} (${uniq(words)})`,
    excerpt: words[0],
  }];
}

// ── glossary ─────────────────────────────────────────────────────────────────

/**
 * `glossary_violation`: a banned form of the style's glossary (the banned-terms normalisation: case, apostrophes;
 * word-bounded, `*` = the rest of a word), an error with the right form when the glossary has one. Links are not
 * read; hashtags are («#спотифай»).
 */
export function glossaryFindings(text: string, style: ResourceStyle | null | undefined): StyleFinding[] {
  const entries = glossaryEntries(style?.glossary);
  if (!entries.length) return [];
  const t = normalizeSlop(stripUrls(text));
  const out: StyleFinding[] = [];
  for (const e of entries) {
    const n = normalizeSlop(e.term);
    if (!n) continue;
    const re = phraseRegex(n);
    const m = t.match(re);
    if (!m) continue;
    // As written in the post (case kept) when the plain text shows it; the normalised match otherwise.
    const word = stripUrls(text).replace(APOS, 'ʼ').match(new RegExp(re.source, 'iu'))?.[0] ?? m[0];
    out.push({
      code: 'glossary_violation', level: 'error',
      message: e.use ? `глосарій ресурсу: «${word}» → пиши «${e.use}»` : `глосарій ресурсу забороняє «${word}»`,
      excerpt: word,
    });
  }
  return out;
}

// ── names ────────────────────────────────────────────────────────────────────

/**
 * First names that mark a person's name. Kept short and unambiguous: names that are also products or words of the
 * trade (Claude, Grace, Ray, Max, Alexa, Siri, Gemini) are left out on purpose.
 */
const LATIN_FIRST = new Set([
  'Mustafa', 'Sam', 'Elon', 'Mark', 'Tim', 'Satya', 'Sundar', 'Jensen', 'Dario', 'Demis', 'Ilya', 'Greg', 'Jeff', 'Bill', 'Steve',
  'Tony', 'Lisa', 'Mira', 'Kevin', 'John', 'Andrew', 'James', 'George', 'Michael', 'David', 'Richard', 'Robert', 'William',
  'Thomas', 'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Donald', 'Paul', 'Stephen', 'Steven', 'Brian', 'Joshua', 'Chris',
  'Jason', 'Ryan', 'Jacob', 'Nicholas', 'Eric', 'Jonathan', 'Justin', 'Brandon', 'Benjamin', 'Scott', 'Peter', 'Frank',
  'Patrick', 'Aaron', 'Emma', 'Olivia', 'Sophia', 'Charlotte', 'Emily', 'Sarah', 'Ashley', 'Jessica', 'Jennifer', 'Megan',
  'Kate', 'Susan', 'Mary', 'Lauren', 'Asha', 'Hideo', 'Phil', 'Shigeru', 'Todd', 'Yann', 'Geoffrey', 'Alexandr', 'Alexander',
  'Noam', 'Arthur', 'Marc', 'Reid', 'Larry', 'Sergey', 'Masayoshi', 'Jony', 'Andrej', 'Mike', 'Jack', 'Joe', 'Ben', 'Dan',
  'Matt', 'Tom', 'Nick', 'Alex', 'Josh', 'Adam', 'Simon', 'Oliver', 'Harry', 'Lucas', 'Liam', 'Noah', 'Ethan', 'Henry',
  'Ivan', 'Olga', 'Anna', 'Maria', 'Elena', 'Natalia', 'Brad', 'Pat', 'Lip-Bu', 'Kai-Fu', 'Fei-Fei', 'Aidan',
]);
const CYR_FIRST = new Set([
  'Ендрю', 'Тоні', 'Ілон', 'Сем', 'Сатья', 'Сундар', 'Дженсен', 'Даріо', 'Деміс', 'Тім', 'Джон', 'Джефф', 'Білл', 'Стів',
  'Ліза', 'Міра', 'Кевін', 'Джеймс', 'Джордж', 'Майкл', 'Девід', 'Річард', 'Роберт', 'Вільям', 'Крістофер', 'Деніел',
  'Метью', 'Ентоні', 'Дональд', 'Пол', 'Стівен', 'Браян', 'Кріс', 'Джейсон', 'Райан', 'Джейкоб', 'Ерік', 'Джонатан',
  'Джастін', 'Бенджамін', 'Скотт', 'Пітер', 'Френк', 'Патрік', 'Емма', 'Олівія', 'Шарлотта', 'Емілі', 'Сара', 'Ешлі',
  'Джессіка', 'Дженніфер', 'Меган', 'Кейт', 'Сьюзан', 'Мері', 'Лорен', 'Аша', 'Хідео', 'Філ', 'Сігеру', 'Тодд', 'Ян',
  'Джеффрі', 'Александр', 'Александер', 'Ноам', 'Артур', 'Рід', 'Ларрі', 'Сергій', 'Масайоші', 'Джоні', 'Андрей', 'Майк',
  'Джек', 'Джо', 'Бен', 'Ден', 'Метт', 'Том', 'Нік', 'Алекс', 'Джош', 'Адам', 'Саймон', 'Олівер', 'Гаррі', 'Лукас', 'Ліам',
  'Ноа', 'Ітан', 'Генрі', 'Бред', 'Пет', 'Мустафа', 'Марк', 'Ілля',
]);
/** Ukrainian first names a transliteration check must not take for foreign ones (original-script policy). */
const NATIVE_FIRST = new Set(['Марк', 'Ілля', 'Сергій', 'Адам', 'Артур', 'Ян', 'Олівер']);

const LATIN_NAME = /(?<![\p{L}\p{N}_@./-])([A-Z][a-z]+(?:-[A-Z][a-z]+)?) ([A-Z][a-z'’]+(?:-[A-Z][a-z]+)?)(?![\p{L}\p{N}_])/gu;
const CYR_NAME = /(?<![\p{L}\p{N}_ʼ-])([А-ЯІЇЄҐ][а-яіїєґʼ’']+) ([А-ЯІЇЄҐ][а-яіїєґʼ’']+(?:-[А-ЯІЇЄҐ][а-яіїєґʼ’']+)?)(?![\p{L}\p{N}_ʼ])/gu;

export interface NameUse { latin: string[]; cyrillic: string[] }

/** Person names of a text by script: a known first name followed by a capitalised word in the same script. */
export function personNames(text: string): NameUse {
  const t = stripUrls(text);
  const latin = [...t.matchAll(LATIN_NAME)].filter((m) => LATIN_FIRST.has(m[1])).map((m) => `${m[1]} ${m[2]}`);
  const cyrillic = [...t.matchAll(CYR_NAME)].filter((m) => CYR_FIRST.has(m[1]) && !NATIVE_FIRST.has(m[1])).map((m) => `${m[1]} ${m[2]}`);
  return { latin: [...new Set(latin)], cyrillic: [...new Set(cyrillic)] };
}

const cyrillicText = (t: string) => {
  const letters = t.match(/\p{L}/gu) ?? [];
  return letters.length >= 20 && letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length / letters.length >= 0.5;
};

/**
 * `name_script_mixed` (warning): with `names: uk_translit`, a person's name in Latin inside Cyrillic text; with
 * `names: original`, a foreign name transliterated into Cyrillic. Without the policy nothing.
 */
export function nameFindings(text: string, style: ResourceStyle | null | undefined): StyleFinding[] {
  if (!style?.names || !cyrillicText(text)) return [];
  const n = personNames(text);
  const bad = style.names === 'uk_translit' ? n.latin : n.cyrillic;
  if (!bad.length) return [];
  return [{
    code: 'name_script_mixed', level: 'warning',
    message: style.names === 'uk_translit'
      ? `імʼя латиницею (${bad.slice(0, 3).join(', ')}), а ресурс пише імена українською транслітерацією`
      : `імʼя транслітом (${bad.slice(0, 3).join(', ')}), а ресурс пише імена в оригіналі`,
    excerpt: bad[0],
  }];
}

// ── units ────────────────────────────────────────────────────────────────────

/** «3B», «270M», «1,05T», «49B»: a number with a Latin B / M / T (K is left out: 2K and 4K are resolutions). */
const LATIN_UNIT = /(?<![\p{L}\p{N}_.,-])(\d+(?:[.,]\d+)?)([BMT])(?![\p{L}\p{N}_])/gu;

/** The word before an index, skipping version numbers («Gemma 3 27B» → «Gemma»). */
function wordBefore(text: string, index: number): string {
  const words = text.slice(0, index).trimEnd().split(/\s+/);
  let i = words.length - 1;
  while (i >= 0 && /^[\d.]+$/.test(words[i])) i--;
  return i >= 0 && text.slice(0, index).endsWith(' ') ? words[i] : '';
}

/**
 * `units_latin` (warning): with `units: words`, a number with a Latin magnitude letter. Model names are left alone:
 * attached to a name by a hyphen («d1-3B», «Qwen3.8-27B») or right after a Latin word («Saluki 27B»).
 */
export function unitFindings(text: string, style: ResourceStyle | null | undefined): StyleFinding[] {
  if (style?.units !== 'words') return [];
  const t = stripUrls(text);
  const hits: string[] = [];
  for (const m of t.matchAll(LATIN_UNIT)) {
    if (/[A-Za-z]/.test(wordBefore(t, m.index!))) continue;
    hits.push(m[0]);
  }
  if (!hits.length) return [];
  return [{
    code: 'units_latin', level: 'warning',
    message: `одиниці латиницею (${[...new Set(hits)].slice(0, 4).join(', ')}) — пиши словами: «3 млрд параметрів», «270 млн»`,
    excerpt: hits[0],
  }];
}

// ── hashtags ─────────────────────────────────────────────────────────────────

/** Hashtags written in a text: `#word` with a letter, not inside a link or a word («C#»), not «#1». */
export function textHashtags(text: string): string[] {
  const t = stripUrls(text).replace(/`[^`\n]*`/g, ' ');
  return [...t.matchAll(/(?<![\p{L}\p{N}_&#/])#(?=[\p{N}_]*\p{L})([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
}

/** `hashtag_while_off` (error): with `hashtags: off`, any hashtag in the post (the hashtag line or the text). */
export function hashtagFindings(text: string, tags: readonly string[], style: ResourceStyle | null | undefined): StyleFinding[] {
  if (style?.hashtags !== 'off') return [];
  const all = [...new Set([...tags, ...textHashtags(text)].map((h) => h.replace(/^#/, '')))];
  if (!all.length) return [];
  return [{
    code: 'hashtag_while_off', level: 'error',
    message: `хештеги на цьому ресурсі вимкнено — прибери ${all.slice(0, 5).map((h) => `#${h}`).join(' ')}`,
    excerpt: `#${all[0]}`,
  }];
}
