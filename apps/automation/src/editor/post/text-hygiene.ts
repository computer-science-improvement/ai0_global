/**
 * Spec 037 T6: the character-level hygiene of a post — broken characters (U+FFFD, control chars, zero-width
 * characters inside words, mojibake) and words that mix Cyrillic and Latin letters. Pure helpers shared by the
 * integrity checks (`integrity/checks/`), the critic gate (a broken char never reaches publish) and the
 * typography normaliser (`typography.ts`, which turns homoglyph-only mixes back into Cyrillic).
 */

/** C0 / C1 control characters except tab, line feed and carriage return. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
/** Zero-width characters between two letters or digits (inside a word; a ZWJ inside an emoji sequence is fine). */
const ZERO_WIDTH_IN_WORD = /(?<=[\p{L}\p{N}])[​‌‍⁠﻿]+(?=[\p{L}\p{N}])/u;
/** The second byte of a UTF-8 Cyrillic letter (0x80–0xBF) as windows-1251 shows it. */
const CP1251_HIGH = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџЎўЈ¤Ґ¦§Ё©Є«¬®Ї°±Ііґµ¶·ё№є»јЅѕї';
/** The same byte as windows-1252 / latin-1 shows it. */
const CP1252_HIGH = '\u0080-¿‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
/**
 * Typical mojibake: UTF-8 Cyrillic read as windows-1251 («РџСЂРёРІС–С‚») or latin-1 («Ð¿Ñ€Ð¸»), UTF-8 punctuation
 * read as windows-1252 («â€™», «â€œ») and Latin accents («Ã©»). Two letter pairs in a row for the Cyrillic forms,
 * so a real word such as «Рівне» (Р + і) never matches.
 */
const MOJIBAKE = new RegExp(`(?:[РС][${CP1251_HIGH}]){2,}|(?:[ÐÑ][${CP1252_HIGH}]){2,}|â€.|Ã[\\u0080-\\u00BF]`, 'u');

export type BrokenCharKind = 'replacement' | 'control' | 'zero_width' | 'mojibake';

export interface BrokenChar { kind: BrokenCharKind; /** The word around it (one line, short). */ excerpt: string }

const KIND_TEXT: Record<BrokenCharKind, string> = {
  replacement: 'символ-замінник U+FFFD («�») — слово пошкоджене',
  control:     'керівний символ у тексті',
  zero_width:  'невидимий символ нульової ширини всередині слова',
  mojibake:    'кракозябри (текст декодовано не в тому кодуванні)',
};

export const brokenCharText = (k: BrokenCharKind): string => KIND_TEXT[k];

/** The word (letters, digits, the broken chars themselves) around index `i`, at most ~40 chars, made visible. */
function wordAt(text: string, i: number, len: number): string {
  const isWordChar = (c: string) => /[\p{L}\p{N}ʼ'’�​‌‍⁠﻿\u0000-\u001F\u007F-\u009F-]/u.test(c);
  let a = i;
  let b = i + len;
  while (a > 0 && i - a < 20 && isWordChar(text[a - 1])) a--;
  while (b < text.length && b - i < 20 && isWordChar(text[b])) b++;
  return text.slice(a, b).replace(/[\u0000-\u001F\u007F-\u009F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/[​‌‍⁠﻿]/g, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase()}]`);
}

/** Every kind of broken character in a text, once per kind, with the word it sits in. */
export function findBrokenChars(text: string): BrokenChar[] {
  const out: BrokenChar[] = [];
  const at = (kind: BrokenCharKind, m: RegExpExecArray | null) => { if (m) out.push({ kind, excerpt: wordAt(text, m.index, m[0].length) }); };
  at('replacement', /�+/u.exec(text));
  at('control', CONTROL.exec(text));
  at('zero_width', ZERO_WIDTH_IN_WORD.exec(text));
  at('mojibake', MOJIBAKE.exec(text));
  return out;
}

// ── mixed scripts ───────────────────────────────────────────────────────────

/** Latin letters that look like a Cyrillic one (the Ukrainian alphabet), and that Cyrillic letter. */
export const LATIN_HOMOGLYPHS: Readonly<Record<string, string>> = {
  a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х',
};

const CYR = /\p{Script=Cyrillic}/u;
const LAT = /\p{Script=Latin}/u;
const count = (s: string, re: RegExp) => [...s].filter((c) => re.test(c)).length;

/** Two or more Latin letters opening or closing a word: a Latin word glued on («aiновини»), not a typo. */
const LATIN_EDGE = /^\p{Script=Latin}{2,}|\p{Script=Latin}{2,}$/u;

/**
 * How a single run of letters (no hyphen) mixes scripts: `null` = one script (or none); `homoglyph` = an otherwise
 * Cyrillic word whose Latin letters all look like Cyrillic ones (more Cyrillic than Latin letters, no Latin word
 * glued to an edge), fixable in code; `mixed` = a real mix such as «Меркoff» or «aiновини».
 */
export function mixKind(part: string): 'homoglyph' | 'mixed' | null {
  const cyr = count(part, CYR);
  const lat = count(part, LAT);
  if (!cyr || !lat) return null;
  const latins = [...part].filter((c) => LAT.test(c));
  return cyr > lat && !LATIN_EDGE.test(part) && latins.every((c) => LATIN_HOMOGLYPHS[c]) ? 'homoglyph' : 'mixed';
}

/** An otherwise Cyrillic word with its Latin look-alike letters replaced by the Cyrillic ones (other words unchanged). */
export function fixHomoglyphWord(part: string): string {
  return mixKind(part) === 'homoglyph' ? [...part].map((c) => (LAT.test(c) ? LATIN_HOMOGLYPHS[c] ?? c : c)).join('') : part;
}

export interface MixedWord { word: string; kind: 'homoglyph' | 'mixed'; hashtag: boolean }

/** URLs, e-mail addresses and @mentions: never words of the post. */
const NOT_WORDS = /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+|(?<![\p{L}\p{N}])@\w+/gu;
/** A word or a hashtag: letters, digits, apostrophes, hyphens and underscores. */
const TOKEN = /#?[\p{L}\p{M}\p{N}ʼ'’_-]+/gu;

/**
 * Words and hashtags that mix Cyrillic and Latin letters. A hyphen separates scripts legitimately
 * («iPhone-ом», «AI-агент»), so each hyphen part of a word is judged on its own; a hashtag is judged whole.
 * Each distinct word once.
 */
export function findMixedScriptWords(text: string): MixedWord[] {
  const out: MixedWord[] = [];
  const seen = new Set<string>();
  for (const m of text.replace(NOT_WORDS, ' ').matchAll(TOKEN)) {
    const token = m[0].replace(/^[-'’ʼ_]+|[-'’ʼ_]+$/g, '');
    if (!token || seen.has(token)) continue;
    const hashtag = token.startsWith('#');
    const parts = hashtag ? [token.slice(1)] : token.split('-');
    const kinds = parts.map(mixKind).filter((k): k is 'homoglyph' | 'mixed' => k !== null);
    if (!kinds.length) continue;
    seen.add(token);
    // A hashtag is never auto-fixed (the normaliser leaves hashtags alone), so any mix in it is a real one.
    out.push({ word: token, kind: hashtag || kinds.includes('mixed') ? 'mixed' : 'homoglyph', hashtag });
  }
  return out;
}

// ── attribution next to the rendered source ─────────────────────────────────

/** «Джерело: X», «Джерела: X», «За даними X» opening a sentence. */
const ATTRIBUTION = /^(?:джерел[оа]\s*[:—–-]|за\s+даними\s)\s*(.+)$/iu;

const squash = (s: string) => s.toLowerCase().replace(/^www\./, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** The names a rendered source goes by: its label and the site name of its host (techcrunch.com → techcrunch). */
export function sourceNames(url: string | undefined, label?: string | null): string[] {
  const names = new Set<string>();
  if (label && squash(label).length >= 3) names.add(squash(label));
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '').split('.');
      const site = host.length >= 2 ? host[host.length - 2] : host[0];
      if (site && site.length >= 3) names.add(squash(site));
    } catch { /* not a URL */ }
  }
  return [...names];
}

/**
 * The sentence when it attributes the post to the rendered source («Джерело: Financial Times через TechCrunch» next
 * to «→ TechCrunch»), else null.
 */
export function attributionOf(sentence: string, names: readonly string[]): string | null {
  const m = ATTRIBUTION.exec(sentence.trim());
  if (!m || !names.length) return null;
  const said = squash(m[1]);
  return names.some((n) => said.includes(n)) ? sentence.trim() : null;
}
