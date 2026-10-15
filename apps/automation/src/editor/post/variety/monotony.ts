import { localDate } from '../../roles/time';
import { bodyText, excerptOf, type AuditPost, type Finding } from '../integrity/types';

/**
 * Spec 037 FR-009 (T9): variety. Deterministic signals of a monotonous resource, computed from its last 20 posts:
 *  • an opening pattern repeated — a «5 X» listicle (a count in the opening paragraph and a list of that many
 *    items), a «Що X:» subheading, the same first word — the third time in 3 days (`monotony_opening`);
 *  • a 3–5-word phrase shared with two earlier posts — «назавжди в бібліотеці» in three giveaways (`monotony_phrase`);
 *  • the same format and topic twice in one local day (`monotony_format_topic`; only posts that carry the planner's
 *    format and topic — a slot — are compared, an export does not know them).
 * Warnings for the critic; the writer gets the same signals up front as the «Уже було» block (`alreadyUsedBlock`).
 */

/** The resource's history the signals read: its last posts, newest first. */
export const MONOTONY_WINDOW = 20;
/** Opening patterns count within this many hours before the post. */
export const OPENING_WINDOW_HOURS = 72;
/** The use that warns: the third «5 X» / «Що X:» / first word in the window, the third use of a phrase. */
export const REPEAT_WARNS_AT = 3;

const APOS = /[’'`ʹ]/g;
const norm = (s: string) => s.toLowerCase().replace(APOS, 'ʼ');
const CYR_WORD = /^[\p{Script=Cyrillic}ʼ-]+$/u;

// ── opening patterns ─────────────────────────────────────────────────────────

export type OpeningKind = 'count_list' | 'cho_heading' | 'first_word';
export interface OpeningPattern { kind: OpeningKind; key: string; label: string }

const NUMERALS: Record<string, number> = {
  три: 3, трьох: 3, трьом: 3, чотири: 4, чотирьох: 4, пʼять: 5, пʼяти: 5, шість: 6, шести: 6, сім: 7, семи: 7,
  вісім: 8, восьми: 8, девʼять: 9, девʼяти: 9, десять: 10, десяти: 10,
};
/** A count and the word after it: «5 термінів», «Пʼять готових шаблонів», «три безкоштовні новинки». */
const COUNT_RE = /(?<![\p{L}\p{N}])(\d{1,2}|[\p{L}ʼ’']+)(?=\s+([\p{L}ʼ’'-]{3,}))/gu;
/** A list item line of the reader text (`•` bullets, `1.` numbering). */
const ITEM_RE = /^\s*(?:•|\d{1,2}[.)])\s+\S/;
/** «Що сталося:», «Що це означає для вас:», «Що всередині:» — a line opening with «Що …:». */
const CHO_RE = /^\s*(Що(?:\s+[^\s:\n]+){1,6}):/mu;

/** The opening paragraph: the text up to the first blank line (the lead), at most 300 chars. */
function openingOf(body: string): string {
  return body.trim().split(/\n\s*\n/)[0].slice(0, 300);
}

/** The opening patterns of one post (each kind at most once). */
export function openingPatterns(post: Pick<AuditPost, 'text'>): OpeningPattern[] {
  const body = bodyText(post);
  const out: OpeningPattern[] = [];
  const items = body.split('\n').filter((l) => ITEM_RE.test(l)).length;
  if (items >= 3) {
    for (const m of openingOf(body).matchAll(COUNT_RE)) {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMERALS[norm(m[1])];
      if (n && n === items && !STOP.has(norm(m[2]))) {
        out.push({ kind: 'count_list', key: 'count_list', label: `«${m[1]} ${m[2]}…» зі списком із ${n} пунктів` });
        break;
      }
    }
  }
  const cho = CHO_RE.exec(body);
  if (cho) out.push({ kind: 'cho_heading', key: 'cho_heading', label: `підзаголовок «${cho[1]}:»` });
  const first = /^[\s«"(]*([\p{L}ʼ’'-]+)/u.exec(body)?.[1];
  if (first && CYR_WORD.test(norm(first)) && [...first].length >= 2) {
    out.push({ kind: 'first_word', key: `first_word:${norm(first)}`, label: `перше слово «${first}»` });
  }
  return out;
}

// ── shared phrases ───────────────────────────────────────────────────────────

/** Function words: a phrase needs two words outside this list (and of 4+ letters) to count. */
const STOP = new Set(('і й та а але або чи що це як у в на до від з із зі за по про для без під над при через між ' +
  'не ні ще вже лише тільки також теж навіть де коли щоб бо ж же так то той та ті цей ця ці його її їх вони він вона ' +
  'воно ми ви ти я свій своє своя свої є був була було були буде будуть може можна треба ось тут там').split(' '));

export const PHRASE_WORDS = 3;

/**
 * The 3-word phrases of a post as order-free keys (sorted words), so «назавжди в бібліотеці» and «в бібліотеці
 * назавжди» are one phrase; 4- and 5-word repeats contain them. Only Cyrillic words (names and titles in Latin repeat
 * by nature), no numbers, two content words of 4+ letters. Value: the phrase as first written.
 */
export function phrasesOf(post: Pick<AuditPost, 'text'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const para of bodyText(post).split(/\n+/)) {
    for (const sentence of para.split(/[.!?…:;—–()«»"]+/)) {
      const raw = [...sentence.matchAll(/[\p{L}\p{N}ʼ’'`-]+/gu)].map((m) => m[0]);
      for (let i = 0; i + PHRASE_WORDS <= raw.length; i++) {
        const run = raw.slice(i, i + PHRASE_WORDS);
        const words = run.map(norm);
        if (!words.every((w) => CYR_WORD.test(w))) continue;
        if (words.filter((w) => !STOP.has(w) && [...w].length >= 4).length < 2) continue;
        const key = [...words].sort().join(' ');
        if (!out.has(key)) out.set(key, run.join(' '));
      }
    }
  }
  return out;
}

// ── signals over a history ───────────────────────────────────────────────────

const hoursBetween = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 3_600_000;

/** The last posts the signals read: earlier than the post, newest first, at most MONOTONY_WINDOW. */
export function historyOf(post: Pick<AuditPost, 'id' | 'publishedAt'>, previous: readonly AuditPost[]): AuditPost[] {
  return previous
    .filter((p) => p.id !== post.id && Date.parse(p.publishedAt) <= Date.parse(post.publishedAt))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MONOTONY_WINDOW);
}

/** Earlier posts with each opening pattern of the post, within OPENING_WINDOW_HOURS. */
function openingRepeats(post: AuditPost, history: AuditPost[]): Array<{ p: OpeningPattern; earlier: AuditPost[] }> {
  const recent = history.filter((h) => hoursBetween(post.publishedAt, h.publishedAt) <= OPENING_WINDOW_HOURS);
  const theirs = recent.map((h) => ({ h, keys: new Set(openingPatterns(h).map((p) => p.key)) }));
  return openingPatterns(post).map((p) => ({ p, earlier: theirs.filter((t) => t.keys.has(p.key)).map((t) => t.h) }));
}

/** Phrases of the post already used in two (or more) of the earlier posts. */
function phraseRepeats(post: AuditPost, history: AuditPost[]): Array<{ phrase: string; uses: number }> {
  const counts = new Map<string, number>();
  for (const h of history) for (const k of phrasesOf(h).keys()) counts.set(k, (counts.get(k) ?? 0) + 1);
  const out: Array<{ phrase: string; uses: number }> = [];
  for (const [k, phrase] of phrasesOf(post)) {
    const uses = counts.get(k) ?? 0;
    if (uses + 1 >= REPEAT_WARNS_AT) out.push({ phrase, uses });
  }
  return out;
}

/** Content words of a planner topic, cut to a 5-letter stem («роздача», «роздачі» → «розда»). */
function topicStems(topic: string): Set<string> {
  return new Set([...norm(topic).matchAll(/[\p{L}\p{N}ʼ-]+/gu)].map((m) => m[0]).filter((w) => [...w].length >= 4 && !STOP.has(w)).map((w) => [...w].slice(0, 5).join('')));
}
/** Two planner topics are the same topic at this word overlap (Jaccard of stems). */
export const SAME_TOPIC_OVERLAP = 0.5;
export function sameTopic(a: string, b: string): boolean {
  const x = topicStems(a); const y = topicStems(b);
  if (!x.size || !y.size) return false;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / (x.size + y.size - inter) >= SAME_TOPIC_OVERLAP;
}

/** Every monotony finding of a post against the resource's earlier posts (newest first). */
export function monotonyFindings(post: AuditPost, previous: readonly AuditPost[]): Finding[] {
  const history = historyOf(post, previous);
  if (!history.length) return [];
  const out: Finding[] = [];
  for (const { p, earlier } of openingRepeats(post, history)) {
    if (earlier.length + 1 < REPEAT_WARNS_AT) continue;
    out.push({
      code: 'monotony_opening', level: 'warning',
      message: `${p.label} — ${earlier.length + 1}-й раз за ${OPENING_WINDOW_HOURS / 24} дні; почни інакше`,
      excerpt: excerptOf(bodyText(post), 80),
    });
  }
  const phrases = phraseRepeats(post, history);
  if (phrases.length) {
    out.push({
      code: 'monotony_phrase', level: 'warning',
      message: `фраза вже була в ${phrases[0].uses} з останніх ${history.length} постів — скажи інакше`,
      excerpt: phrases.slice(0, 3).map((x) => x.phrase).join('; '),
    });
  }
  if (post.format && post.topic) {
    const day = localDate(new Date(post.publishedAt), post.timezone);
    const twin = history.find((h) => h.format === post.format && h.topic && localDate(new Date(h.publishedAt), h.timezone) === day && sameTopic(h.topic, post.topic!));
    if (twin) {
      out.push({
        code: 'monotony_format_topic', level: 'warning',
        message: `${post.format} на цю ж тему вже виходив сьогодні («${excerptOf(twin.topic!, 60)}») — інший формат або тема`,
        excerpt: excerptOf(post.topic, 80),
      });
    }
  }
  return out;
}

// ── the writer's «Уже було» block ───────────────────────────────────────────

export const ALREADY_USED_LIMIT = 600;
export const ALREADY_USED_PHRASES = 6;

/**
 * The «Уже було» block of the writer prompt: the patterns and phrases the next post would repeat for the second
 * time or more (so the writer avoids them before the critic has to say it), from the same signals as the check.
 * Null when there is nothing to avoid. At most ALREADY_USED_LIMIT chars.
 */
export function alreadyUsedBlock(previous: readonly AuditPost[], now: Date): string | null {
  const history = [...previous].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, MONOTONY_WINDOW);
  if (!history.length) return null;
  const at = now.toISOString();
  const recent = history.filter((h) => hoursBetween(at, h.publishedAt) <= OPENING_WINDOW_HOURS);
  const openings = new Map<string, { label: string; n: number }>();
  for (const h of recent) {
    for (const p of openingPatterns(h)) {
      const e = openings.get(p.key) ?? { label: p.kind === 'count_list' ? '«N X» зі списком (5 термінів, пʼять шаблонів)' : p.label, n: 0 };
      e.n++;
      openings.set(p.key, e);
    }
  }
  const counts = new Map<string, { phrase: string; n: number }>();
  for (const h of history) {
    for (const [k, phrase] of phrasesOf(h)) {
      const e = counts.get(k) ?? { phrase, n: 0 };
      e.n++;
      counts.set(k, e);
    }
  }
  const pats = [...openings.values()].filter((o) => o.n >= REPEAT_WARNS_AT - 1).sort((a, b) => b.n - a.n);
  const phr = [...counts.values()].filter((c) => c.n >= REPEAT_WARNS_AT - 1).sort((a, b) => b.n - a.n).slice(0, ALREADY_USED_PHRASES);
  if (!pats.length && !phr.length) return null;
  const lines = [`## Уже було (останні ${history.length} постів) — не повторюй`];
  if (pats.length) lines.push(`- Початки й структура за ${OPENING_WINDOW_HOURS / 24} дні: ${pats.map((o) => `${o.label} ×${o.n}`).join('; ')}.`);
  if (phr.length) lines.push(`- Фрази: ${phr.map((c) => `«${c.phrase}» ×${c.n}`).join('; ')}.`);
  const block = lines.join('\n');
  return block.length > ALREADY_USED_LIMIT ? `${block.slice(0, ALREADY_USED_LIMIT - 1).trimEnd()}…` : block;
}
