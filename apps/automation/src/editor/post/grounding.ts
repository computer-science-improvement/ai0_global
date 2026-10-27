import { extractEntities } from './entities';
import { localDay, MONTHS_GENITIVE } from './dates';

/**
 * Spec 037 FR-004 (T4): are the post's numbers in the pages the writer read? Pure and deterministic.
 *
 * The claims of a post are its prices, percentages, counts with units, scaled numbers and dates, normalised to a
 * value: «1,05 трлн» = 1.05e12, «850 тисяч» = 850 000, «2 599 грн» = 2599, «$0.10» = 0.1, «4 центи» = 0.04, «−75%» = 75 %, «15 жовтня» =
 * 10-15. Not claims: years, the post's own date, times, list numbering («1. Роль»), product versions («Gemini 4»,
 * «Qwen-Image-2.1», «Red Dead Redemption 2»), small bare integers (< 10, «5 термінів»), anything inside quotes (a
 * prompt example «Мені 35, вага 80 кг», a quoted title).
 *
 * A source number matches when it is the same value within the post's rounding («1,2 млн» ≈ 1 234 567) or within 10 %
 * (5 % for a percentage) after «понад», «майже», «близько», «до» (an approximation). English and Ukrainian forms both
 * parse: «1.05T», «850,000», «850K», «1 million», «$14.5B», «75% off», «October 15», «Oct. 15», «2026-10-15».
 *
 * The same module gives the critic its source context (`sourcePassages`): ±400 chars around the post's numbers and
 * names on the pages read, ≤ 6 passages, ≤ 6000 chars, instead of the page head.
 */

export type ClaimKind = 'percent' | 'money' | 'count' | 'date' | 'bill' | 'ratio';

export interface PostNumber {
  /** As written in the post. */
  text: string;
  kind: ClaimKind;
  /** Normalised value (scale applied); a date is MM * 100 + DD. */
  value: number;
  /** The rounding unit of the written form («1,05 трлн» → 1e10, «649» → 1). */
  unit: number;
  /** «понад», «майже», «близько», «до», «~»: a looser match. */
  approx: boolean;
  /** Spec 046 FR-009: the other readings of an ambiguous core («5,120» = 5.12 or 5120); any of them may match. */
  alt?: Array<{ value: number; unit: number }>;
  /** [start, end) in the text it was read from. */
  span: [number, number];
  /** Spec 063 FR-001: a bill's canonical name («sb53» for "Senate Bill 53" and «SB 53»); the match is by name, not by value. Spec 067: a ratio's «N/M». */
  key?: string;
}

/** A page or feed item the run read, as grounding needs it. */
export interface GroundingSource {
  url: string;
  text?: string | null;
  title?: string | null;
}

export interface GroundingResult {
  /** Some source had text: the numbers were checked. */
  checked: boolean;
  /** Every claim of the post. */
  numbers: PostNumber[];
  /** Claims found in no source. */
  missing: PostNumber[];
  /** Claims found, with the URLs of the sources that have them. */
  found: Array<{ number: PostNumber; urls: string[] }>;
}

// ── parsing ──────────────────────────────────────────────────────────────────

const SP = '[ \\u00A0\\u202F\\u2009]';
const SCALE_RE = new RegExp(String.raw`^${SP}?(трлн|трильйон\p{L}*|млрд|мільярд\p{L}*|млн|мільйон\p{L}*|тисяч\p{L}*|тис\.?|trillion|billion|million|thousand|bn|mln|mn|[KMBT](?![\p{L}\p{N}]))`, 'u');
const CURRENCY_AFTER_RE = new RegExp(String.raw`^${SP}?(грн|гривень|гривні|гривня|гривнi|₴|UAH|USD|EUR|доларів|долари|долара|долар|дол\.|євро|€|\$|юанів|юанів|фунтів)(?![\p{L}])`, 'u');
/** «4 центи», «5 cents», «4¢»: money in hundredths («4 центи за мільйон» = $0.04). */
const CENTS_AFTER_RE = new RegExp(String.raw`^${SP}?(цент\p{L}*|cents?|¢)(?![\p{L}])`, 'u');
const PERCENT_RE = new RegExp(String.raw`^${SP}?(%|відсот\p{L}*|percent\b|per cent\b)`, 'u');
/** A unit word right after a bare number: makes a small integer a claim («5 кг», «8 кроків» stay out below 10 anyway). */
const CURRENCY_BEFORE_RE = /([$€£¥₴])\s?$/u;
const APPROX_RE = /(?:понад|більше\s+ніж|більше|майже|близько|приблизно|щонайменше|менш\s+ніж|менше|до|около|over|more\s+than|nearly|almost|about|around|up\s+to|~|≈)\s*$/iu;
const DISCOUNT_RE = /(?:знижк\p{L}*|дешевш\p{L}*|кешбек\p{L}*|off\b|sale\b|розпродаж\p{L}*)/iu;

const SCALE: Array<[RegExp, number]> = [
  [/^(трлн|трильйон|trillion|T$)/iu, 1e12], [/^(млрд|мільярд|billion|bn|B$)/iu, 1e9], [/^(млн|мільйон|million|mln|mn|M$)/iu, 1e6],
  [/^(тис|тисяч|thousand|K$)/iu, 1e3],
];

const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_EN_RE = String.raw`(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?`;
const MONTH_UK_RE = `(${MONTHS_GENITIVE.join('|')})`;

const scaleOf = (w: string): number => SCALE.find(([re]) => re.test(w))?.[1] ?? 1;
const monthEn = (w: string): number => MONTHS_EN.indexOf(w.toLowerCase().slice(0, 3)) + 1;

/** Blank out [a, b) keeping offsets. */
function blank(s: string, a: number, b: number): string {
  return s.slice(0, a) + ' '.repeat(Math.max(0, b - a)) + s.slice(b);
}

function blankAll(s: string, re: RegExp): string {
  let out = s;
  for (const m of s.matchAll(re)) out = blank(out, m.index!, m.index! + m[0].length);
  return out;
}

/** The parts of a post that hold no claims: quotes, URLs, hashtags, times, list numbers, the `→ source` line. */
function maskPost(text: string): string {
  let t = text;
  t = blankAll(t, /«[^«»\n]*»|“[^“”\n]*”|"[^"\n]*"|„[^“\n]*“/gu);
  t = blankAll(t, /https?:\/\/\S+|(?:[a-z0-9-]+\.)+(?:com|io|ai|org|net|dev|app|co|ua|gg|tv|me|so|xyz)\S*/giu);
  t = blankAll(t, /#[\p{L}\p{N}_]+/gu);
  t = blankAll(t, /(?<![\p{N}])\d{1,2}:\d{2}(?![\p{N}])/gu);
  t = blankAll(t, /^[ \t•·\-–]*\d{1,2}[.)](?=\s)/gmu);
  t = blankAll(t, /^→.*$/gmu);
  return t;
}

// ── spec 063 FR-001: spelled scales and bill names ───────────────────────────

const WORD_ONES: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  один: 1, одна: 1, одне: 1, два: 2, дві: 2, три: 3, чотири: 4, "п'ять": 5, шість: 6, сім: 7, вісім: 8, "дев'ять": 9, десять: 10,
};
const WORD_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM_WORD = String.raw`(?:${Object.keys(WORD_TENS).join('|')})(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|${Object.keys(WORD_ONES).map((w) => w.replace(/'/g, "['ʼ’]")).join('|')}`;
/** "over a billion dollars", "two million users", «один мільярд»: a scale with a number word and no digit. */
const SPELLED_SCALE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(${NUM_WORD})${SP}+(trillion|billion|million|thousand|трильйон\p{L}*|мільярд\p{L}*|мільйон\p{L}*|тисяч\p{L}*)(?![\p{L}])`, 'giu');
/** "forty percent", "fifty-five per cent". */
const SPELLED_PERCENT_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(${NUM_WORD})${SP}+(?:percent|per cent)(?![\p{L}])`, 'giu');

function wordValue(w: string): number | null {
  const k = w.toLowerCase().replace(/[ʼ’]/g, "'");
  const [a, b] = k.split(/[- ]/);
  if (WORD_TENS[a] != null) return WORD_TENS[a] + (b ? WORD_ONES[b] ?? 0 : 0);
  return WORD_ONES[k] ?? null;
}

/** Spelled-out numbers of a source text, as number entries (the post side writes digits). */
function scanSpelled(text: string): RawNumber[] {
  const out: RawNumber[] = [];
  const push = (v: number, scale: number, kind: ClaimKind, m: RegExpMatchArray) => {
    out.push({ value: v * scale, unit: scale, kind, span: [m.index!, m.index! + m[0].length], text: m[0], approx: false, version: false, year: false, bare: false });
  };
  for (const m of text.matchAll(SPELLED_SCALE_RE)) {
    const v = wordValue(m[1]);
    if (v != null) push(v, scaleOf(m[2]), 'count', m);
  }
  for (const m of text.matchAll(SPELLED_PERCENT_RE)) {
    const v = wordValue(m[1]);
    if (v != null) push(v, 1, 'percent', m);
  }
  return out;
}

/** "Senate Bill 53", "S.B. 53", «SB53», "Assembly Bill 1018", "H.R. 1": one key per bill (spec 063 FR-001). */
const BILL_RE = /(?<![\p{L}\p{N}])(?:(Senate|Assembly|House)\s+Bill|(S|A|H)\.?\s?B\.?|H\.?\s?R\.?)\s?(?:No\.?\s?)?(\d{1,5})(?![\p{N}])/gu;

interface RawBill { key: string; text: string; span: [number, number] }

function scanBills(text: string): RawBill[] {
  const out: RawBill[] = [];
  for (const m of text.matchAll(BILL_RE)) {
    const body = m[1] ? `${m[1][0].toLowerCase()}b` : m[2] ? `${m[2].toLowerCase()}b` : 'hr';
    out.push({ key: `${body}${Number(m[3])}`, text: m[0], span: [m.index!, m.index! + m[0].length] });
  }
  return out;
}

// ── spec 067 FR-001: ratios («5 з 10», "5 of 10", "5/10") ──────────────────────

/**
 * One part of a ratio is a whole number token: a space-grouped thousand count («10 000», «1 500», regular, no-break or
 * thin space) or up to 5 plain digits. The guards keep a match from starting or ending inside a group («000 з 20»,
 * «200 з 1» of «1 500»).
 */
const RATIO_PART = String.raw`(\d{1,3}(?:${SP}\d{3})+|\d{1,5})`;
const RATIO_START = String.raw`(?<![\p{L}\p{N}.,/])(?<!\p{N}${SP})`;
const RATIO_NOT_GROUP = String.raw`${SP}\d{3}(?!\p{N})`;
/** «N з M», «N із M», «N зі M», "N out of M", "N of M": a ratio, not two numbers. Not before a month («5 з 10 травня»). */
const RATIO_WORD_RE = new RegExp(String.raw`${RATIO_START}${RATIO_PART}${SP}+(?:з|із|зі|out${SP}+of|of)${SP}+${RATIO_PART}(?![\p{N}]|[.,]\d|/\d|${RATIO_NOT_GROUP}|${SP}+${MONTH_UK_RE}(?![\p{L}]))`, 'giu');
/** "N/M" — not inside a date («10/19/2026»: no lookbehind hit on «19/2026», no lookahead hit on «10/19»). */
const RATIO_SLASH_RE = new RegExp(String.raw`${RATIO_START}${RATIO_PART}${SP}?/${SP}?${RATIO_PART}(?![\p{N}]|[.,]\d|/\d|${RATIO_NOT_GROUP})`, 'gu');

interface RawRatio { key: string; text: string; span: [number, number]; value: number }

/** A part of a ratio that is a claim on its own once it stands alone (the rule of small numbers, years). */
const claimPart = (p: number): boolean => p >= 10 && !(p >= 1900 && p <= 2100);

/**
 * Ratios of a text: key «N/M» for every spelling. «5 з 10 млн», «5 з 10%», «5 з 10 грн» are numbers with a unit, not
 * ratios. On the post side a ratio is a claim only when a part is one on its own (not < 10, not a year), and an «N/M»
 * after a Latin word is a version.
 */
function scanRatios(text: string, post: boolean): RawRatio[] {
  const out: RawRatio[] = [];
  for (const re of [RATIO_WORD_RE, RATIO_SLASH_RE]) {
    for (const m of text.matchAll(re)) {
      const end = m.index! + m[0].length;
      const rest = text.slice(end, end + 24);
      if (SCALE_RE.test(rest) || PERCENT_RE.test(rest) || CURRENCY_AFTER_RE.test(rest)) continue;
      // «10 000» and «1 500» are one number: the digits of a part, whatever its grouping space.
      const [a, b] = [Number(m[1].replace(/\D/g, '')), Number(m[2].replace(/\D/g, ''))];
      if (post && !claimPart(a) && !claimPart(b)) continue;
      // «Windows 10/11», «Android 14/15»: versions are not ratios (the numbers are skipped as versions, as before 067).
      if (post && re === RATIO_SLASH_RE && versionLike(text.slice(Math.max(0, m.index! - 24), m.index!))) continue;
      out.push({ key: `${a}/${b}`, text: m[0], span: [m.index!, end], value: b ? a / b : 0 });
    }
  }
  return out.sort((x, y) => x.span[0] - y.span[0]);
}

interface RawNumber { value: number; unit: number; kind: ClaimKind; span: [number, number]; text: string; approx: boolean; version: boolean; year: boolean; bare: boolean }

/** Values a number core may mean: «1,050» is 1050 (English thousands) or 1.05 (Ukrainian decimal). */
function coreValues(core: string, source: boolean): Array<{ value: number; unit: number }> {
  const c = core.replace(/[\u00A0\u202F\u2009]/g, ' ');
  // Spec 046 FR-009: thousands with decimals, English «2,599.99» and European «1.299,50».
  const en = /^\d{1,3}(?:,\d{3})+\.(\d+)$/.exec(c);
  if (en) return [{ value: Number(c.replace(/,/g, '')), unit: 10 ** -en[1].length }];
  const eu = /^\d{1,3}(?:\.\d{3})+,(\d+)$/.exec(c);
  if (eu) return [{ value: Number(c.replace(/\./g, '').replace(',', '.')), unit: 10 ** -eu[1].length }];
  if (/^\d{1,3}(?: \d{3})+$/.test(c)) return [{ value: Number(c.replace(/ /g, '')), unit: 1 }];
  const groups = /^\d{1,3}(?:([,.])\d{3})+$/.exec(c);
  if (groups) {
    const thousands = { value: Number(c.replace(/[,.]/g, '')), unit: 1 };
    const multi = (c.match(/[,.]/g) ?? []).length > 1;
    // «1,05» never matches here (2 digits); «2,599» in a post is a Ukrainian decimal only by mistake: both readings.
    if (multi) return [thousands];
    const dec = Number(c.replace(',', '.'));
    return source ? [thousands, { value: dec, unit: 0.001 }] : [{ value: dec, unit: 0.001 }, thousands];
  }
  const d = /^(\d+)(?:[.,](\d+))?$/.exec(c);
  if (!d) return [];
  const decimals = d[2]?.length ?? 0;
  return [{ value: Number(`${d[1]}${d[2] ? `.${d[2]}` : ''}`), unit: decimals ? 10 ** -decimals : 1 }];
}

// Spec 046 FR-009: thousands with decimals first; a plain number followed by «,2» / «.3» is an enumeration («1,2,3») or
// a version («2.5.1») and is not read at all.
const NUM_CORE = String.raw`\d{1,3}(?:,\d{3})+\.\d+|\d{1,3}(?:\.\d{3})+,\d+|\d{1,3}(?:${SP}\d{3})+(?![.,]?\d)|\d{1,3}(?:[,.]\d{3})+(?![\d])|\d+(?:[.,]\d+)?(?![.,]\d)`;
/**
 * A range to a second number («20–30 тисяч», «5 до 7 млн», «20 and 30 million»): the first number also reads with the
 * second's scale (both readings are kept, the scaled one first).
 */
const RANGE_RE = new RegExp(String.raw`^${SP}?(?:[-‐‑–—]|до|to|and|or|і|й|та|або)${SP}?\d[\d.,]*`, 'u');
const NUM_RE = new RegExp(String.raw`(?<![\p{L}\p{N}.,_/])(${NUM_CORE})`, 'gu');

/** A version: the number follows a Latin word (or is glued to one by a hyphen): «Gemini 4», «GPT-6», «Redemption 2». */
function versionLike(before: string): boolean {
  return /[A-Za-z][A-Za-z0-9+]*(?:[ \u00A0-]|\s?v\.?)$/.test(before) && !/(?:^|[\s(])(?:of|to|in|on|at|by|for|with|from|than|up|and|or|x|v)\s$/i.test(before);
}

function scanNumbers(text: string, source: boolean): RawNumber[] {
  const out: RawNumber[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const start = m.index!;
    let end = start + m[1].length;
    const before = text.slice(Math.max(0, start - 24), start);
    let rest = text.slice(end, end + 24);
    // An ordinal or a compound word («25-річчя», «5-й», «8-step») is not a quantity.
    // Spec 046 FR-009: any hyphen («18‑core» with U+2011 too).
    if (/^[-‐‑–][\p{L}]/u.test(rest) && !/^[-‐‑–](?:річн|відсот)/u.test(rest)) continue;
    let scale = 1;
    const sc = SCALE_RE.exec(rest);
    if (sc) { scale = scaleOf(sc[1]); end += sc[0].length; rest = text.slice(end, end + 24); }
    const range = !sc ? RANGE_RE.exec(rest) : null;
    const rangeScale = range ? SCALE_RE.exec(text.slice(end + range[0].length, end + range[0].length + 24)) : null;
    if (rangeScale) scale = scaleOf(rangeScale[1]);
    let kind: ClaimKind = 'count';
    const pc = PERCENT_RE.exec(rest);
    const cur = CURRENCY_AFTER_RE.exec(rest);
    const curBefore = CURRENCY_BEFORE_RE.exec(before);
    const cents = !pc && !cur ? CENTS_AFTER_RE.exec(rest) : null;
    if (pc) { kind = 'percent'; end += pc[0].length; } else if (cur) { kind = 'money'; end += cur[0].length; } else if (cents) { kind = 'money'; scale *= 0.01; end += cents[0].length; }
    if (curBefore) kind = kind === 'percent' ? kind : 'money';
    const begin = curBefore ? start - curBefore[0].length : start;
    const marked = kind !== 'count' || scale !== 1 || !!rangeScale;
    const vals = coreValues(m[1], source);
    if (!vals.length) continue;
    const approx = APPROX_RE.test(before.replace(/[−–-]\s?$/, ''));
    const v0 = vals[0];
    const year = !marked && v0.unit === 1 && v0.value >= 1900 && v0.value <= 2100 && !/\s/.test(m[1]);
    const version = !marked && !source && versionLike(before);
    const bare = !marked && v0.unit === 1 && v0.value < 10;
    for (const v of vals) {
      out.push({
        value: v.value * scale, unit: v.unit * scale, kind, span: [begin, end], text: text.slice(begin, end).trim(),
        approx, version, year, bare,
      });
      if (rangeScale) out.push({ value: v.value, unit: v.unit, kind, span: [begin, end], text: text.slice(begin, end).trim(), approx, version, year, bare });
    }
  }
  return out;
}

const DATE_UK_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(\d{1,2})${SP}+${MONTH_UK_RE}(?![\p{L}])`, 'giu');
const DATE_EN_DM_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(\d{1,2})(?:st|nd|rd|th)?${SP}+${MONTH_EN_RE}(?![\p{L}])`, 'giu');
const DATE_EN_MD_RE = new RegExp(String.raw`(?<![\p{L}])${MONTH_EN_RE}${SP}+(\d{1,2})(?:st|nd|rd|th)?(?![\p{N}])`, 'giu');
const DATE_ISO_RE = /(?<![\p{N}])(20\d{2})-(\d{2})-(\d{2})(?![\p{N}])/gu;
/** «12.10», «12.10.2026»: a two-digit month and no unit after it («2.5 млрд», «1.05T» are numbers). */
const DATE_DOT_RE = /(?<![\p{L}\p{N}.,])(\d{1,2})\.(0[1-9]|1[0-2])(?:\.(\d{2,4}))?(?![\p{N}]|[.,]\d|\s?(?:%|[KMBT]\b|млн|млрд|трлн|тис|грн|₴|\$))/gu;

interface RawDate { value: number; span: [number, number]; text: string }

function scanDates(text: string, source: boolean): RawDate[] {
  const out: RawDate[] = [];
  const push = (mm: number, dd: number, m: RegExpMatchArray) => {
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) out.push({ value: mm * 100 + dd, span: [m.index!, m.index! + m[0].length], text: m[0] });
  };
  for (const m of text.matchAll(DATE_UK_RE)) push(MONTHS_GENITIVE.indexOf(m[2].toLowerCase() as typeof MONTHS_GENITIVE[number]) + 1, Number(m[1]), m);
  for (const m of text.matchAll(DATE_DOT_RE)) push(Number(m[2]), Number(m[1]), m);
  if (source) {
    for (const m of text.matchAll(DATE_EN_DM_RE)) push(monthEn(m[2]), Number(m[1]), m);
    for (const m of text.matchAll(DATE_EN_MD_RE)) push(monthEn(m[1]), Number(m[2]), m);
    for (const m of text.matchAll(DATE_ISO_RE)) push(Number(m[2]), Number(m[3]), m);
    for (const m of text.matchAll(/(?<![\p{N}/])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\p{N}])/gu)) push(Number(m[1]), Number(m[2]), m);
  }
  return out;
}

/**
 * The claims of a post's text (see the module comment for what is not a claim). `publishedAt` + `timezone` drop the
 * post's own date.
 */
export function postNumbers(text: string, o: { publishedAt?: string; timezone?: string } = {}): PostNumber[] {
  let masked = maskPost(text);
  const own = o.publishedAt ? localDay(o.publishedAt, o.timezone || 'Europe/Kyiv') : null;
  const ownValue = own ? Number(own.slice(5, 7)) * 100 + Number(own.slice(8, 10)) : null;
  const out: PostNumber[] = [];
  for (const b of scanBills(masked)) {
    masked = blank(masked, b.span[0], b.span[1]);
    out.push({ text: b.text.trim(), kind: 'bill', value: Number(b.key.replace(/\D/g, '')), unit: 1, approx: false, span: b.span, key: b.key });
  }
  // Spec 067: «5 з 10» is one claim (the ratio 5/10); its parts are not checked on their own.
  for (const r of scanRatios(masked, true)) {
    masked = blank(masked, r.span[0], r.span[1]);
    out.push({ text: r.text.trim(), kind: 'ratio', value: r.value, unit: 1, approx: false, span: r.span, key: r.key });
  }
  for (const d of scanDates(masked, false)) {
    masked = blank(masked, d.span[0], d.span[1]);
    if (d.value === ownValue) continue;
    out.push({ text: d.text.trim(), kind: 'date', value: d.value, unit: 1, approx: false, span: d.span });
  }
  const seen = new Map<number, PostNumber>();
  for (const n of scanNumbers(masked, false)) {
    // The first reading of an ambiguous core is the post's; the others are kept as alternatives (spec 046 FR-009).
    const first = seen.get(n.span[0]);
    if (first) { (first.alt ??= []).push({ value: n.value, unit: n.unit }); continue; }
    if (n.year || n.version || n.bare) { seen.set(n.span[0], {} as PostNumber); continue; }
    const p: PostNumber = { text: n.text, kind: n.kind, value: n.value, unit: n.unit, approx: n.approx, span: n.span };
    seen.set(n.span[0], p);
    out.push(p);
  }
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

interface SourceIndex {
  values: Array<{ value: number; percent: boolean; span: [number, number] }>; dates: Array<{ value: number; span: [number, number] }>;
  bills: Array<{ key: string; span: [number, number] }>; ratios: Array<{ key: string; span: [number, number] }>;
}

const indexCache = new Map<string, SourceIndex>();

/** Every number and date of a source text (cached by text; a run reads the same page for lint and the critic). */
function sourceIndex(text: string): SourceIndex {
  const hit = indexCache.get(text);
  if (hit) return hit;
  const idx: SourceIndex = {
    values: [...scanNumbers(text, true), ...scanSpelled(text)].map((n) => ({ value: n.value, percent: n.kind === 'percent', span: n.span })),
    dates: scanDates(text, true).map((d) => ({ value: d.value, span: d.span })),
    bills: scanBills(text).map((b) => ({ key: b.key, span: b.span })),
    // The source keeps its plain numbers too (a ratio's parts stay indexed): the post side blanks, this side does not.
    ratios: scanRatios(text, false).map((r) => ({ key: r.key, span: r.span })),
  };
  if (indexCache.size > 64) indexCache.clear();
  indexCache.set(text, idx);
  return idx;
}

function tolerance(n: Pick<PostNumber, 'value' | 'unit' | 'approx' | 'kind'>): number {
  const rounding = n.unit / 2 + Math.abs(n.value) * 1e-9;
  // «понад 850 тисяч» for 857 000; a percentage is looser by less («понад 80%» is not 75%).
  return n.approx ? Math.max(rounding, Math.abs(n.value) * (n.kind === 'percent' ? 0.05 : 0.1)) : rounding;
}

/** Where a post number occurs in a source text: the spans of the matching source numbers (empty = not there). */
export function findInSource(n: PostNumber, text: string): Array<[number, number]> {
  const idx = sourceIndex(text);
  if (n.kind === 'bill') return idx.bills.filter((b) => b.key === n.key).map((b) => b.span);
  if (n.kind === 'date') return idx.dates.filter((d) => d.value === n.value).map((d) => d.span);
  if (n.kind === 'ratio') {
    const same = idx.ratios.filter((r) => r.key === n.key).map((r) => r.span);
    if (same.length) return same;
    // Spec 067 A9: another way of writing it («5 of the 10 models»): the parts that are claims on their own, by value as before.
    const parts = (n.key ?? '').split('/').map(Number).filter(claimPart);
    const spans = parts.map((p) => idx.values.filter((s) => Math.abs(s.value - p) <= 0.5).map((s) => s.span));
    return parts.length && spans.every((x) => x.length) ? spans.flat() : [];
  }
  const readings = [{ value: n.value, unit: n.unit }, ...(n.alt ?? [])].map((r) => ({ value: r.value, tol: tolerance({ ...n, ...r }) }));
  return idx.values
    .filter((s) => (n.kind === 'percent' ? s.percent : true) && readings.some((r) => Math.abs(s.value - r.value) <= r.tol))
    .map((s) => s.span);
}

/** Check every claim of a post against the texts of the sources read in the run. */
export function groundNumbers(text: string, sources: readonly GroundingSource[], o: { publishedAt?: string; timezone?: string } = {}): GroundingResult {
  const numbers = postNumbers(text, o);
  const withText = sources.filter((s) => typeof s.text === 'string' && s.text.trim());
  if (!withText.length) return { checked: false, numbers, missing: [], found: [] };
  const missing: PostNumber[] = [];
  const found: GroundingResult['found'] = [];
  for (const n of numbers) {
    const urls = withText.filter((s) => findInSource(n, s.text!).length > 0).map((s) => s.url);
    if (urls.length) found.push({ number: n, urls }); else missing.push(n);
  }
  return { checked: true, numbers, missing, found };
}

/** Percentages of a post that are claims about the world (not a discount, «знижка 20%», «−75%»). */
export function statisticalPercents(text: string, o: { publishedAt?: string; timezone?: string } = {}): PostNumber[] {
  return postNumbers(text, o).filter((n) => {
    if (n.kind !== 'percent') return false;
    const around = text.slice(Math.max(0, n.span[0] - 30), n.span[1] + 30);
    return !DISCOUNT_RE.test(around) && !/[−–-]\s?$/.test(text.slice(Math.max(0, n.span[0] - 2), n.span[0]));
  });
}

// ── critic passages ──────────────────────────────────────────────────────────

/** Spec 041 FR-006: up to 8 passages (claims without numbers get their own), 8000 chars. */
export const PASSAGE = { radius: 400, max: 8, chars: 8_000 } as const;

/**
 * Spec 041 FR-006: a sentence that claims something on someone's word — a quote or an attribution verb. Quotes and
 * statements without numbers had no passage, so the critic could not check «Маск заявив…» against the source.
 */
export const ATTRIBUTION_RE = /(?<![\p{L}ʼ])(?:заяви(?:в|ла|ли)|сказа(?:в|ла|ли)|за\s+словами|повідоми(?:в|ла|ли)|каже|кажуть|пише|пишуть|зазначи(?:в|ла|ли)|наголоси(?:в|ла|ли)|визна(?:в|ла|ли)|підтверди(?:в|ла|ли)|пообіця(?:в|ла|ли)|за\s+даними)(?![\p{L}ʼ])/iu;
export const QUOTE_RE = /«[^»]{12,}»|“[^”]{12,}”|"[^"]{12,}"/u;

const LATIN_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'has', 'have', 'will', 'not', 'you', 'its', 'our']);

/** The claim sentences of a post without numbers, each with the words to look for in a source (Latin words, names). */
export function claimAnchors(postText: string): Array<{ label: string; tokens: string[] }> {
  const out: Array<{ label: string; tokens: string[] }> = [];
  const sentences = postText.split(/\n+/).flatMap((l) => l.split(/(?<=[.!?…])\s+/));
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || /\d/.test(s) || !(QUOTE_RE.test(s) || ATTRIBUTION_RE.test(s))) continue;
    const latin = (s.match(/[A-Za-z][A-Za-z0-9'’-]{2,}/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !LATIN_STOP.has(w));
    const names = [...extractEntities(s).entities.values()].filter((e) => e.kind === 'name' || e.kind === 'person').map((e) => e.text.toLowerCase().split(/\s+/)[0]);
    const tokens = [...new Set([...latin, ...names])].filter((t) => t.length >= 3);
    if (tokens.length) out.push({ label: `твердження: «${s.length > 60 ? `${s.slice(0, 59)}…` : s}»`, tokens });
  }
  return out;
}

/** The position in a page where most of the claim's tokens meet (within one passage radius), or null. */
function claimHit(tokens: readonly string[], page: string): [number, number] | null {
  const lower = page.toLowerCase();
  const at = tokens.map((t) => {
    const xs: number[] = [];
    for (let i = lower.indexOf(t); i >= 0 && xs.length < 30; i = lower.indexOf(t, i + t.length)) xs.push(i);
    return xs;
  });
  let best: { i: number; n: number } | null = null;
  for (const xs of at) for (const i of xs) {
    const n = at.filter((ys) => ys.some((y) => Math.abs(y - i) <= PASSAGE.radius)).length;
    if (!best || n > best.n) best = { i, n };
  }
  const need = Math.min(2, tokens.length);
  return best && best.n >= need ? [best.i, best.i + 1] : null;
}

export interface SourcePage {
  url: string;
  text: string;
  title?: string | null;
  publishedAt?: string | null;
}

export interface Passage {
  url: string;
  text: string;
  /** What the passage is around (the post's numbers and names it contains), for the prompt. */
  about: string[];
}

interface Hit { page: number; at: [number, number]; label: string }

function snap(text: string, a: number, b: number): [number, number] {
  let s = Math.max(0, a);
  let e = Math.min(text.length, b);
  if (s > 0) { const sp = text.slice(s, s + 40).search(/\s/); if (sp >= 0) s += sp + 1; }
  if (e < text.length) { const tail = text.slice(Math.max(s, e - 40), e); const sp = tail.search(/\s\S*$/); if (sp >= 0) e = Math.max(s, e - 40) + sp; }
  return [s, e];
}

/** The post's names worth finding in a page: multi-word products, people, titles (big brands alone are too common). */
function postNames(text: string): string[] {
  const e = extractEntities(text);
  return [...e.entities.values()]
    .filter((x) => (x.kind === 'name' && x.weight >= 2) || x.kind === 'person')
    .sort((a, b) => b.weight - a.weight)
    .map((x) => x.text.trim())
    .filter((t, i, all) => t.length >= 3 && all.indexOf(t) === i)
    // «Argon» inside «Gemini 4 Argon» is the same name.
    .filter((t, _, all) => !all.some((o) => o !== t && o.toLowerCase().includes(t.toLowerCase())));
}

/**
 * The critic's source context (spec 037 T4): passages of ±400 chars around the post's numbers (first), names
 * (then) and claims without numbers (spec 041: quotes, «заявив / за словами») on the pages read — the cited page
 * first, other pages for what the cited one lacks — at most 8 passages and 8000 chars, in page order. Empty when nothing of the post is on the pages (the caller then says so).
 */
export function sourcePassages(postText: string, pages: readonly SourcePage[], o: { publishedAt?: string; timezone?: string } = {}): Passage[] {
  const hits: Hit[] = [];
  const numbers = postNumbers(postText, o);
  const names = postNames(postText);
  for (const n of numbers) {
    for (let p = 0; p < pages.length; p++) {
      const spans = findInSource(n, pages[p].text);
      if (spans.length) { hits.push({ page: p, at: spans[0], label: n.text }); break; }
    }
  }
  const numberHits = [...hits];
  for (const name of names) {
    const needle = name.toLowerCase();
    for (let p = 0; p < pages.length; p++) {
      const lower = pages[p].text.toLowerCase();
      const at: number[] = [];
      for (let i = lower.indexOf(needle); i >= 0 && at.length < 50; i = lower.indexOf(needle, i + needle.length)) at.push(i);
      if (!at.length) continue;
      // The occurrence next to a number of the post (the same passage), else the first one after the title line.
      const title = pages[p].title && lower.startsWith(pages[p].title!.toLowerCase()) ? pages[p].title!.length : 0;
      const near = at.find((i) => numberHits.some((h) => h.page === p && Math.abs(h.at[0] - i) <= PASSAGE.radius));
      const i = near ?? at.find((x) => x >= title) ?? at[0];
      hits.push({ page: p, at: [i, i + needle.length], label: name });
      break;
    }
  }
  // Spec 041 FR-006: quotes and attributed claims without numbers, by their Latin words and names.
  for (const c of claimAnchors(postText)) {
    for (let p = 0; p < pages.length; p++) {
      const at = claimHit(c.tokens, pages[p].text);
      if (at) { hits.push({ page: p, at, label: c.label }); break; }
    }
  }
  const windows: Array<{ page: number; a: number; b: number; about: string[] }> = [];
  let total = 0;
  for (const h of hits) {
    const inside = windows.find((w) => w.page === h.page && h.at[0] >= w.a && h.at[1] <= w.b);
    if (inside) { if (!inside.about.includes(h.label)) inside.about.push(h.label); continue; }
    if (windows.length >= PASSAGE.max || total >= PASSAGE.chars) continue;
    const text = pages[h.page].text;
    let [a, b] = snap(text, h.at[0] - PASSAGE.radius, h.at[1] + PASSAGE.radius);
    // An overlapping window of the same page grows instead of a second passage.
    const near = windows.find((w) => w.page === h.page && a <= w.b && b >= w.a);
    if (near) {
      total -= near.b - near.a;
      near.a = Math.min(near.a, a); near.b = Math.max(near.b, b);
      total += near.b - near.a;
      near.about.push(h.label);
      continue;
    }
    if (total + (b - a) > PASSAGE.chars) b = Math.max(a, a + (PASSAGE.chars - total));
    if (b <= a) continue;
    windows.push({ page: h.page, a, b, about: [h.label] });
    total += b - a;
  }
  return windows
    .sort((x, y) => x.page - y.page || x.a - y.a)
    .map((w) => {
      const text = pages[w.page].text;
      const body = text.slice(w.a, w.b).replace(/\s+/g, ' ').trim();
      return { url: pages[w.page].url, about: w.about, text: `${w.a > 0 ? '…' : ''}${body}${w.b < text.length ? '…' : ''}` };
    });
}
