import { localDate, localTimeLabel, localWeekday, zonedToUtc } from '../roles/time';

/**
 * Spec 037 FR-005: the dates of a Ukrainian post, pure. `parseDateMentions` finds relative words («сьогодні»,
 * «завтра», «післязавтра», «вчора», «позавчора»), weekdays in every case («у вівторок», «до середи», «з п'ятниці»),
 * explicit dates («12 жовтня», «12.10», «12.10.2026», «12 жовтня 2026 року»), times («17:00», «о 16:00 за Києвом»)
 * and the prepositions that make a deadline or a start («до 15 жовтня 17:00», «з 16 жовтня»). Relative words and
 * dates without a year resolve against the publish instant in the resource zone (IANA, DST-correct via Intl).
 *
 * Mentions that stand next to each other («завтра, 12 жовтня», «у вівторок, 14 жовтня», «15 жовтня о 17:00») share
 * a `group`: they name one day, which is what the date checks compare. A month without a day («у листопаді 2024
 * року») is not a mention; a date with a past year is `historical` and no rule reads it.
 */

export type DateMentionKind = 'relative' | 'weekday' | 'date' | 'time';

export interface DateMention {
  kind: DateMentionKind;
  /** Local calendar day (YYYY-MM-DD) in the resource zone: relative words and dates; a weekday never has one. */
  date?: string;
  /** Local time HH:MM, on a time and on the date / relative word it follows («15 жовтня 17:00»). */
  time?: string;
  /** The zone of `time`: the resource zone, `Europe/Kyiv` for «за Києвом», `UTC`; absent when the post names another zone. */
  zone?: string;
  /** [start, end) in the text. */
  span: [number, number];
  /** The words as written. */
  text: string;
  /** Relative words: days from the publish day (завтра = 1, вчора = −1). */
  offset?: number;
  /** Weekdays: 0 = Sunday … 6 = Saturday. */
  weekday?: number;
  /** «до …» = until (a deadline), «з / із / від …» = from (a start). Shared by the group. */
  preposition?: 'until' | 'from';
  /** The year is written («12.10.2026», «12 жовтня 2026 року»). */
  explicitYear?: boolean;
  /** A written year before the publish year: history, never a rule. */
  historical?: boolean;
  /** Mentions with the same group name one day. */
  group: number;
}

export interface DateResolution {
  /** Publish (scheduled) instant, ISO. */
  publishedAt: string;
  /** Resource zone (IANA). */
  timezone: string;
}

const L = '(?<![\\p{L}\\p{N}ʼ\'’])';
const R = '(?![\\p{L}\\p{N}ʼ\'’])';

export const MONTHS_GENITIVE = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'] as const;

const RELATIVE: Record<string, number> = { позавчора: -2, вчора: -1, учора: -1, сьогодні: 0, завтра: 1, післязавтра: 2 };

/** Weekday stems with their case endings (singular: a plural «по середах» is a habit, not a day). */
const WEEKDAYS: Array<[RegExp, number]> = [
  [/^понеділ(?:ок|ка|ку|ком)$/u, 1],
  [/^вівтор(?:ок|ка|ку|ком)$/u, 2],
  [/^серед(?:а|и|у|і|ою)$/u, 3],
  [/^четвер(?:га|гу|гом)?$/u, 4],
  [/^п[ʼ'’]?ятниц(?:я|і|ю|ею)$/u, 5],
  [/^субот(?:а|и|у|і|ою)$/u, 6],
  [/^неділ(?:я|і|ю|ею)$/u, 0],
];

const RELATIVE_RE = new RegExp(`${L}(позавчора|вчора|учора|сьогодні|післязавтра|завтра)${R}`, 'giu');
const WEEKDAY_RE = new RegExp(`${L}(понеділ(?:ок|ка|ку|ком)|вівтор(?:ок|ка|ку|ком)|серед(?:а|и|у|і|ою)|четвер(?:га|гу|гом)?|п[ʼ'’]?ятниц(?:я|і|ю|ею)|субот(?:а|и|у|і|ою)|неділ(?:я|і|ю|ею))${R}`, 'giu');
const TEXT_DATE_RE = new RegExp(`(?<![\\p{L}\\p{N}.,])(\\d{1,2})(?:-?(?:го|е))?\\s+(${MONTHS_GENITIVE.join('|')})${R}(?:\\s+(\\d{4})(?:\\s*(?:року|р\\.?)${R})?)?`, 'giu');
/** «12.10», «08.10», «12.10.2026»; not a decimal, a version after a Latin word («Python 3.10») or a US «10.12.26». */
const NUM_DATE_RE = /(?<![\p{L}\p{N}.,/$€£])(?<![A-Za-z][\w-]*\s)(\d{1,2})\.(\d{2})(?:\.(\d{4}))?(?![\p{N}]|[.,]\d)/gu;
const TIME_RE = /(?<![\p{N}:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\p{N}]|:\d)(\s*\(?\s*(?:за\s+(?:київським\s+часом|[\p{L}-]+)|UTC|GMT|PT|PST|PDT|ET|EST|EDT|CET|CEST|BST)(?![\p{L}])\s*\)?)?/gu;

/** Words that may stand between two mentions of one day («вже завтра, 12 жовтня», «у вівторок, 14 жовтня», «о 17:00»). */
const CONNECTORS = new Set(['вже', 'уже', 'тобто', 'а', 'саме', 'у', 'в', 'о', 'об', 'це']);

function adjacent(gap: string): boolean {
  if (gap.length > 24 || /[.!?;\n]/.test(gap)) return false;
  return gap.toLowerCase().split(/[\s,()—–-]+/u).filter(Boolean).every((w) => CONNECTORS.has(w));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` + n days (calendar arithmetic, zone-free). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday of a calendar day. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The year that puts day/month closest to the publish day (12.01 in a post of 28.12 is next January). */
function nearestYear(m: number, d: number, publishDay: string): number {
  const y0 = Number(publishDay.slice(0, 4));
  const base = Date.parse(`${publishDay}T00:00:00Z`);
  let best = y0;
  let bestDist = Infinity;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    if (!validDay(y, m, d)) continue;
    const dist = Math.abs(Date.UTC(y, m - 1, d) - base);
    if (dist < bestDist) { best = y; bestDist = dist; }
  }
  return best;
}

function zoneOfSuffix(suffix: string | undefined, resourceZone: string): string | undefined {
  if (!suffix || !suffix.trim()) return resourceZone;
  if (/києв/iu.test(suffix)) return 'Europe/Kyiv';
  if (/UTC|GMT/u.test(suffix)) return 'UTC';
  return undefined; // another zone: the instant is unknown
}

function prepositionBefore(text: string, start: number): 'until' | 'from' | undefined {
  const m = /(?:^|[^\p{L}])(до|з|із|від)\s+(?:(?:вже|уже|самого|самої|кінця)\s+)?$/iu.exec(text.slice(Math.max(0, start - 24), start));
  if (!m) return undefined;
  return m[1].toLowerCase() === 'до' ? 'until' : 'from';
}

/** Every date mention of `text`, in text order, resolved against the publish day in the resource zone. */
export function parseDateMentions(text: string, at: DateResolution): DateMention[] {
  const publishDay = localDate(new Date(at.publishedAt), at.timezone);
  const publishYear = Number(publishDay.slice(0, 4));
  const raw: Omit<DateMention, 'group'>[] = [];
  const taken: Array<[number, number]> = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  const add = (m: Omit<DateMention, 'group'>) => {
    if (!free(m.span[0], m.span[1])) return;
    taken.push(m.span);
    raw.push(m);
  };

  for (const m of text.matchAll(TEXT_DATE_RE)) {
    const d = Number(m[1]);
    const mo = MONTHS_GENITIVE.indexOf(m[2].toLowerCase() as typeof MONTHS_GENITIVE[number]) + 1;
    const y = m[3] ? Number(m[3]) : nearestYear(mo, d, publishDay);
    if (!validDay(y, mo, d)) continue;
    add({
      kind: 'date', date: `${y}-${pad(mo)}-${pad(d)}`, span: [m.index!, m.index! + m[0].length], text: m[0],
      ...(m[3] ? { explicitYear: true, ...(y < publishYear ? { historical: true } : {}) } : {}),
    });
  }
  for (const m of text.matchAll(NUM_DATE_RE)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = m[3] ? Number(m[3]) : nearestYear(mo, d, publishDay);
    if (!validDay(y, mo, d)) continue;
    add({
      kind: 'date', date: `${y}-${pad(mo)}-${pad(d)}`, span: [m.index!, m.index! + m[0].length], text: m[0],
      ...(m[3] ? { explicitYear: true, ...(y < publishYear ? { historical: true } : {}) } : {}),
    });
  }
  for (const m of text.matchAll(RELATIVE_RE)) {
    const offset = RELATIVE[m[1].toLowerCase()];
    add({ kind: 'relative', offset, date: addDays(publishDay, offset), span: [m.index!, m.index! + m[0].length], text: m[0] });
  }
  for (const m of text.matchAll(WEEKDAY_RE)) {
    const w = m[1].toLowerCase();
    const weekday = WEEKDAYS.find(([re]) => re.test(w))?.[1];
    if (weekday === undefined) continue;
    add({ kind: 'weekday', weekday, span: [m.index!, m.index! + m[0].length], text: m[0] });
  }
  for (const m of text.matchAll(TIME_RE)) {
    const zone = zoneOfSuffix(m[3], at.timezone);
    add({ kind: 'time', time: `${pad(Number(m[1]))}:${m[2]}`, ...(zone ? { zone } : {}), span: [m.index!, m.index! + m[0].length], text: m[0].trim() });
  }

  raw.sort((a, b) => a.span[0] - b.span[0]);
  const out: DateMention[] = [];
  let group = -1;
  for (let i = 0; i < raw.length; i++) {
    const prev = out[i - 1];
    const joined = prev && adjacent(text.slice(prev.span[1], raw[i].span[0]));
    if (!joined) group++;
    out.push({ ...raw[i], group });
  }

  // Per group: the preposition before its first mention, the time after a day, the day of a time.
  for (let g = 0; g <= group; g++) {
    const ms = out.filter((m) => m.group === g);
    const prep = prepositionBefore(text, ms[0].span[0]);
    const day = ms.find((m) => m.kind === 'date') ?? ms.find((m) => m.kind === 'relative');
    const time = ms.find((m) => m.kind === 'time');
    for (const m of ms) {
      if (prep) m.preposition = prep;
      if (time && (m.kind === 'date' || m.kind === 'relative')) {
        m.time = time.time;
        if (time.zone) m.zone = time.zone; else delete m.zone;
      }
      if (m.kind === 'time' && day?.date) {
        m.date = day.date;
        if (day.historical) m.historical = true;
      }
    }
  }
  return out;
}

/** The instant of a mention with a day and a time in a known zone; null otherwise. */
export function mentionInstant(m: Pick<DateMention, 'date' | 'time' | 'zone'>): Date | null {
  if (!m.date || !m.time || !m.zone) return null;
  return zonedToUtc(m.date, m.time, m.zone);
}

/** The local day (YYYY-MM-DD) of an instant in a zone. */
export function localDay(iso: string, timezone: string): string {
  return localDate(new Date(iso), timezone);
}

const WEEKDAY_NAMES = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];

/** «середа, 08.10.2026 14:00 (Europe/Kyiv)»: an instant as the reader of the resource sees it. */
export function formatLocalStamp(iso: string, timezone: string): string {
  const d = new Date(iso);
  const day = localDate(d, timezone);
  const [y, m, dd] = day.split('-');
  return `${WEEKDAY_NAMES[localWeekday(d, timezone)]}, ${dd}.${m}.${y} ${localTimeLabel(d, timezone)} (${timezone})`;
}

export const WEEKDAY_NAME = (w: number): string => WEEKDAY_NAMES[w];

// ── source dates ─────────────────────────────────────────────────────────────

/**
 * The publication day in an article URL (`/2026/10/07/…`, `/2026-10-07-…`): WordPress-style paths of MarkTechPost,
 * TechCrunch, PlayStation Blog. Day precision; null when the path has no full date.
 */
export function dateFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  const m = /(?:^|\/)(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?=[/-]|$)/.exec(path);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return validDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/**
 * Hours from a source's publication to `at`. A day-only date (`2026-10-07`, from a URL or `<time datetime>`) counts
 * from 12:00 UTC of that day (±12 h); an instant counts exactly. Null when the date does not parse.
 */
export function sourceAgeHours(publishedAt: string | null | undefined, at: string): number | null {
  if (!publishedAt) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(publishedAt) ? Date.parse(`${publishedAt}T12:00:00Z`) : Date.parse(publishedAt);
  const now = Date.parse(at);
  if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
  return (now - t) / 3_600_000;
}

/** A published date as found in a page or a feed → ISO (an instant) or `YYYY-MM-DD` (a day); null when unparseable. */
export function normalizePublishedAt(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return validDay(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))) ? s : null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
