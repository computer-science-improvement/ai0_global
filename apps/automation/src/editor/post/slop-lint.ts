import { normalizeSlop } from './slop-phrases';

/**
 * Spec 034 FR-002/FR-003: the resource's voice settings the lint reads —
 * format_prefs.humor / slang (both off by default) and format_prefs.emoji.
 */
export interface VoicePrefs {
  humor?: 'none' | 'light';
  slang?: boolean;
  emoji?: 'none' | 'light' | 'rich';
  /** Spec 034 FR-005: reader-directed questions allowed per post (questions_to_readers_per_day; absent = 1). An error, not a slop warning. */
  readerQuestionsMax?: number;
}

export interface SlopIssue { code: SlopWarningCode; message: string }

/**
 * Warning codes of the slop counters. They never fail a post on their own;
 * the pre-publish critic (spec 034 T2) reads them from `LintResult.warnings`
 * (every code starts with `slop_`, see `isSlopWarning`).
 */
export const SLOP_WARNING_CODES = [
  'slop_em_dash', 'slop_exclamation', 'slop_rhetorical_qa', 'slop_moral_closer', 'slop_adjective_triple',
  'slop_emoji_over_pref', 'slop_humor_off', 'slop_slang_off',
] as const;
export type SlopWarningCode = typeof SLOP_WARNING_CODES[number];

export const isSlopWarning = (code: string): code is SlopWarningCode => (SLOP_WARNING_CODES as readonly string[]).includes(code);

/** One em dash per this many characters (at least one per post) before it reads as an AI rhythm. */
export const EM_DASH_CHARS_PER = 400;
/** More exclamation marks than this per post is a warning. */
export const MAX_EXCLAMATIONS = 1;
/** Emoji per post above which format_prefs.emoji is exceeded. */
export const EMOJI_PREF_MAX: Record<NonNullable<VoicePrefs['emoji']>, number> = { none: 0, light: 3, rich: 12 };

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const WORD = '[\\p{L}\\p{N}ʼ]';

/** Sentences of a text: split after . ! ? … and on line breaks; terminators kept. */
export function sentencesOf(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?…])\s+/)).map((s) => s.trim()).filter((s) => /\p{L}/u.test(s));
}

const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

const INTERROGATIVE = /^(?:а\s+|і\s+|так\s+)?(?:що|чому|навіщо|як|хто|коли|де|куди|звідки|скільки|який|яка|яке|які|чий|чия|чиє|чиї|чи|в чому|у чому|у чім|наскільки)(?![\p{L}ʼ])/u;
/** A question to the readers is an audience ask (spec 034 T3), not a rhetorical one. */
const READER_DIRECTED = /(?<![\p{L}ʼ])(?:ви|вас|вам|ваш\p{L}*|як думаєте|а ви|пишіть|поділіться)(?![\p{L}ʼ])/u;

/** «Що це означає? Компанія скоротить 300 людей.» — a question the next sentence answers. */
export function rhetoricalQa(text: string): string | null {
  const ss = sentencesOf(text);
  for (let i = 0; i + 1 < ss.length; i++) {
    const q = ss[i];
    if (!q.endsWith('?') || ss[i + 1].endsWith('?')) continue;
    const n = normalizeSlop(q.replace(/^[^\p{L}]+/u, ''));
    if (READER_DIRECTED.test(n)) continue;
    if (words(q) <= 3 || (INTERROGATIVE.test(n) && words(q) <= 10)) return q;
  }
  return null;
}

/** Last-sentence wrap-ups that comment on the world instead of stating a fact. */
const MORAL_CLOSER = new RegExp(`^(?:${[
  'тож', 'отже', 'отож', 'таким чином', 'зрештою', 'врешті-решт', 'памʼятайте', 'не забувайте', 'варто памʼятати',
  'головне —', 'головне -', 'головне:', 'і це лише початок', 'це лише початок', 'час покаже', 'майбутнє покаже', 'хай там як', 'як би там не було',
  'можливо саме', 'адже', 'в епоху', 'в еру', 'у світі де', 'в світі де', 'у часи коли', 'в часи коли', 'у час коли',
  'це показує', 'це свідчить', 'це нагадує', 'це змінює', 'це доводить', 'це означає', 'це ще раз', 'такі історії', 'подібні історії',
  'ця історія', 'тенденція', 'зміни відбивають', 'одне зрозуміло', 'одне очевидно', 'питання лише', 'залишається лише',
].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?!${WORD})`, 'u');

export function moralCloser(text: string): string | null {
  const ss = sentencesOf(text);
  const last = ss[ss.length - 1];
  if (!last) return null;
  return MORAL_CLOSER.test(normalizeSlop(last.replace(/^[^\p{L}]+/u, ''))) ? last : null;
}

/** Adjective endings that must agree across the three words (a list of nouns rarely shares them). */
const ADJ_LONG = /(ий|ого|ому|ими|их|ої|ою|ую|юю)$/u;
/** Soft-stem masculine (синій, останній); short words in -ій are mostly nouns (подій, мрій). */
const ADJ_SOFT = /\p{L}{4,}ій$/u;
/** Feminine / neuter / plural nominative after a typical adjective stem consonant. */
const ADJ_SHORT = /[нвкрлчжштх](а|я|е|є|і)$/u;
const NOT_ADJ = /(?:ія|ця|ння|ття|сся)$/u;

function adjEnding(w: string): string | null {
  const x = w.toLowerCase();
  const l = x.match(ADJ_LONG);
  if (l) return l[1];
  if (ADJ_SOFT.test(x)) return 'ій';
  if (NOT_ADJ.test(x)) return null;
  const s = x.match(ADJ_SHORT);
  return s ? s[1] : null;
}

/** «яскравий, сміливий і неймовірний» — three agreeing adjectives in a row. */
export function adjectiveTriple(text: string): string | null {
  const re = /(?<![\p{L}ʼ])([\p{L}ʼ]{4,}),\s+([\p{L}ʼ]{4,})(?:,\s+|\s+(?:і|й|та)\s+)([\p{L}ʼ]{4,})(?![\p{L}ʼ])/gu;
  for (const m of text.matchAll(re)) {
    const e = [m[1], m[2], m[3]].map(adjEnding);
    if (e[0] && e[0] === e[1] && e[1] === e[2]) return m[0];
  }
  return null;
}

/** Joke and meme markers (format_prefs.humor ≠ light) and slang (format_prefs.slang ≠ true). Normalised, word-bounded; `*` = rest of word. */
export const HUMOR_MARKERS: readonly string[] = [
  'ахах*', 'хаха*', 'хехе*', 'лол', 'кек', 'рофл*', 'ору', 'орнув', 'орнула', 'орнули', 'мемчик*', 'мемасик*', 'панчлайн',
  'жартую', 'без жартів', 'ну і жарт', ')))', 'xd', 'лмао', 'lol', 'lmao', '😂', '🤣', '😹', '🤪', '😜',
];
export const SLANG_MARKERS: readonly string[] = [
  'кринж*', 'вайб*', 'имба', 'імба', 'чілити', 'чілимо', 'чіл', 'чилл', 'зашквар*', 'краш', 'бро', 'топчик', 'жиза', 'годнота',
  'треш', 'трешак', 'трешов*', 'капець', 'капєц', 'жесть', 'кайф*', 'прикол', 'приколи', 'приколу', 'прикольн*', 'хайп*', 'агонь', 'кста', 'имхо', 'імхо',
  'офігенн*', 'фігня', 'чувак*', 'пацани', 'шок контент', 'ізі', 'изи',
];

/** Markers are whole words: a hyphen also bounds them out («краш-тест» is not «краш»). */
const MARKER_EDGE = '[\\p{L}\\p{N}ʼ-]';
function markerRegex(m: string): RegExp {
  const body = m.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(`${WORD}*`);
  const lw = /^[\p{L}\p{N}]/u.test(m);
  const rw = /[\p{L}\p{N}*]$/u.test(m);
  return new RegExp(`${lw ? `(?<!${MARKER_EDGE})` : ''}${body}${rw ? `(?!${MARKER_EDGE})` : ''}`, 'u');
}
const HUMOR_RE = HUMOR_MARKERS.map((m) => ({ m, re: markerRegex(m) }));
const SLANG_RE = SLANG_MARKERS.map((m) => ({ m, re: markerRegex(m) }));

function hits(text: string, list: Array<{ re: RegExp }>): string[] {
  const t = normalizeSlop(text);
  const out: string[] = [];
  for (const { re } of list) { const x = t.match(re); if (x && !out.includes(x[0])) out.push(x[0]); }
  return out;
}

export const humorHits = (text: string) => hits(text, HUMOR_RE);
export const slangHits = (text: string) => hits(text, SLANG_RE);

/** Em dashes (— and a spaced –) in a text. */
export const emDashes = (text: string) => (text.match(/—|\s–\s/g) ?? []).length;

/**
 * The slop counters of one post (FR-003): `body` is the main text (sentence
 * structure: rhetorical Q&A, the closing sentence), `all` everything the reader
 * sees (counts and markers). All findings are warnings.
 */
export function slopWarnings(o: { body: string; all?: string; prefs?: VoicePrefs | null }): SlopIssue[] {
  const all = o.all ?? o.body;
  const prefs = o.prefs ?? {};
  const out: SlopIssue[] = [];
  const add = (code: SlopWarningCode, message: string) => out.push({ code, message });

  const dashes = emDashes(o.body);
  const allowed = Math.max(1, Math.floor(o.body.length / EM_DASH_CHARS_PER));
  if (dashes > allowed) add('slop_em_dash', `${dashes} тире на ${o.body.length} символів (до ${allowed}) — заміни частину комами або крапками`);

  const excl = (all.match(/!/g) ?? []).length;
  if (excl > MAX_EXCLAMATIONS) add('slop_exclamation', `${excl} знаків оклику — максимум ${MAX_EXCLAMATIONS} на пост`);

  const qa = rhetoricalQa(o.body);
  if (qa) add('slop_rhetorical_qa', `риторичне питання з відповіддю одразу: «${qa.slice(0, 80)}» — лиши тільки відповідь`);

  const closer = moralCloser(o.body);
  if (closer) add('slop_moral_closer', `моралізаторська кінцівка: «${closer.slice(0, 100)}» — закінчи конкретним фактом або видали це речення`);

  const triple = adjectiveTriple(all);
  if (triple) add('slop_adjective_triple', `три прикметники поспіль: «${triple}» — залиш один-два`);

  if (prefs.emoji) {
    const n = (all.match(EMOJI_RE) ?? []).length;
    const max = EMOJI_PREF_MAX[prefs.emoji];
    if (n > max) add('slop_emoji_over_pref', `емодзі ${n}, а format_prefs.emoji = ${prefs.emoji} (до ${max})`);
  }

  if (prefs.humor !== 'light') {
    const h = humorHits(all);
    if (h.length) add('slop_humor_off', `гумор на цьому ресурсі вимкнено, а в тексті є жарт/мем: ${h.slice(0, 5).map((x) => `«${x}»`).join(', ')}`);
  }
  if (prefs.slang !== true) {
    const s = slangHits(all);
    if (s.length) add('slop_slang_off', `сленг на цьому ресурсі вимкнено: ${s.slice(0, 5).map((x) => `«${x}»`).join(', ')}`);
  }
  return out;
}
