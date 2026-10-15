import { extractEntities } from '../entities';
import { storyMatch, storyView } from '../../story/story-match';
import { bodyText, type AuditContext, type AuditPost } from '../integrity/types';
import { localDate, localTimeLabel } from '../../roles/time';

/**
 * Spec 037 FR-007 (T7): knowledge polls and revealed quiz answers, pure.
 *
 * A knowledge question has one right answer, so it is a quiz (`correct_index` + `explanation`), not a regular poll:
 *   • a question word («який», «скільки», «хто», «коли», «де», all cases) and options that are names or numbers, or
 *   • the answer is already in the text: exactly one option is found in what the reader sees next to the poll.
 * An opinion question («Де ви найчастіше…», «Що ти робиш…», «Яка гра вересня?», «найкраща», «улюблена») stays a
 * regular poll and is never flagged.
 *
 * What the reader sees next to the poll (`revealSources`): the poll's own intro (the spec body), the companion post
 * (an earlier post of the same resource up to COMPANION_MINUTES before — Telegram shows the poll right under it; in an
 * export the intro is a separate message of the same second) and the resource's posts of the same story in the last
 * REVEAL_STORY_HOURS (story/story-match.ts). The quiz `explanation` is where the answer belongs and is not a source.
 *
 * An option is "found" in a text when every significant part of it is there: its numbers with units as one canonical
 * value (post/entities.ts: «49 мільярдів» = «49 млрд» = «49B»), bare numbers as numbers, Latin words as words, Cyrillic
 * words by stem (cases differ). «Усі 1,05 трлн на кожен токен» is not found where only «1,05 трлн» and «кожен токен»
 * are: «усі» is the claim.
 */

export const COMPANION_MINUTES = 10;
export const REVEAL_STORY_HOURS = 24;

const L = String.raw`\p{L}`;
const norm = (s: string) => s.toLowerCase().replace(/[’'`]/g, 'ʼ').replace(/ё/g, 'е');

/** «який» (every case and gender), «скільки», «хто» (cases), «коли», «де». */
const QUESTION_WORD_RE = new RegExp(String.raw`(?<!${L})(?:як(?:ий|а|е|і|ого|ої|ому|ій|им|их|ими|ою|у)|скільки|хто|кого|кому|ким|коли|де)(?!${L})`, 'iu');

/** The reader's own opinion or experience: «ви», «ти», «ваш», «твій». */
const SECOND_PERSON_RE = new RegExp(String.raw`(?<!${L})(?:ви|вас|вам|вами|ваш${L}*|ти|тебе|тобі|тобою|твій|тво(?:я|є|ї|го|єї|їй|їм|їх|єму|їми|ю))(?!${L})|${L}{3,}(?:єте|ете|ите|їте)(?:ся|сь)?(?!${L})`, 'iu');
/** «Чи знаєте ви…», «вгадаєте?»: a knowledge question addressed to the reader is still a knowledge question. */
const GUESS_RE = new RegExp(String.raw`(?<!${L})(?:знаєте|знаєш|вгада${L}*|здогада${L}*|памʼята${L}*)(?!${L})`, 'iu');
/** Evaluation: the reader's taste, not a fact. */
const EVALUATIVE_RE = new RegExp(String.raw`(?<!${L})(?:найкращ|найгірш|улюблен|найцікавіш|найочікуваніш|кращ|гірш|цікавіш|подобає|сподоба|хотіл${L}*\s+б|обрал${L}*\s+б|варто|думаєте|думаєш|вважаєте|вважаєш)`, 'iu');
/** A "best of the period" vote: «Яка гра вересня?», «Фільм року?». */
const PERIOD_VOTE_RE = /(?:тижня|місяця|року|сезону|осені|літа|зими|весни|січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\s*\?*\s*$/iu;

/** One-word answers that are not names even when capitalised. */
const NOT_NAMES = new Set(['так', 'ні', 'інше', 'жоден', 'жодна', 'жодне', 'жодні', 'усі', 'всі', 'обидва', 'обидві', 'ніхто', 'ніколи', 'завжди', 'іноді', 'часто', 'рідко', 'можливо']);

/** Words that carry no answer («Так», «Інше», prepositions): an option of only these is never "found". */
const STOP_WORDS = new Set(['так', 'ні', 'інше', 'можливо', 'не', 'знаю', 'та', 'або', 'чи', 'що', 'для', 'від', 'при', 'над', 'під', 'без', 'про', 'між', 'через', 'після', 'перед', 'біля', 'the', 'and', 'for', 'with']);

export function isOpinionQuestion(question: string): boolean {
  const q = norm(question);
  if (EVALUATIVE_RE.test(q) || PERIOD_VOTE_RE.test(q.trim())) return true;
  return SECOND_PERSON_RE.test(q) && !GUESS_RE.test(q);
}

export const hasQuestionWord = (question: string): boolean => QUESTION_WORD_RE.test(norm(question));

/** A name or a number: digits, Latin, a capitalised word after the first, or a short Title Case answer («Юпітер»). */
export function isNameOrNumber(option: string): boolean {
  const o = option.trim();
  if (/\d/.test(o) || /[A-Za-z]/.test(o)) return true;
  const words = o.split(/\s+/).filter(Boolean);
  if (words.slice(1).some((w) => /^[А-ЯІЇЄҐ]/u.test(w))) return true;
  return words.length <= 3 && words.every((w) => /^[А-ЯІЇЄҐ]/u.test(w)) && !(words.length === 1 && NOT_NAMES.has(norm(words[0])));
}

/** At least two thirds of the options are names or numbers. */
export function optionsAreNamesOrNumbers(options: readonly string[]): boolean {
  return options.length >= 2 && options.filter(isNameOrNumber).length * 3 >= options.length * 2;
}

interface OptionKey { numbers: string[]; bare: string[]; latin: string[]; stems: string[] }

const stemOf = (w: string) => (w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 3)));

/** The significant parts of an option (see the header). Empty = nothing to look for («Так»). */
export function optionKey(option: string): OptionKey {
  let rest = option;
  const numbers: string[] = [];
  for (const e of extractEntities(option).entities.values()) {
    if (e.kind !== 'number') continue;
    numbers.push(e.key);
    rest = rest.replace(e.text, ' ');
  }
  const bare = [...rest.matchAll(/(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)?(?![\p{L}\p{N}]|[.,]\d)/gu)].map((m) => m[0].replace(',', '.'));
  rest = rest.replace(/\d+(?:[.,]\d+)?/g, ' ');
  const words = norm(rest).match(/[\p{L}ʼ]+/gu) ?? [];
  const latin = words.filter((w) => /^[a-z]/.test(w) && w.length >= 2 && !STOP_WORDS.has(w));
  const stems = words.filter((w) => !/^[a-z]/.test(w) && w.length >= 3 && !STOP_WORDS.has(w)).map(stemOf);
  return { numbers, bare, latin, stems };
}

const isEmptyKey = (k: OptionKey) => !k.numbers.length && !k.bare.length && !k.latin.length && !k.stems.length;

/** A text prepared for option lookups (entities and words computed once). */
export interface RevealText { label: string; numbers: Set<string>; bare: Set<string>; words: string[] }

export function revealText(label: string, text: string): RevealText {
  const numbers = new Set([...extractEntities(text).entities.values()].filter((e) => e.kind === 'number').map((e) => e.key));
  const bare = new Set([...text.matchAll(/(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)?(?![\p{L}\p{N}]|[.,]\d)/gu)].map((m) => m[0].replace(',', '.')));
  return { label, numbers, bare, words: norm(text).match(/[\p{L}\p{N}ʼ]+/gu) ?? [] };
}

/** Every significant part of the option is in the text. */
export function optionFoundIn(key: OptionKey, t: RevealText): boolean {
  if (isEmptyKey(key)) return false;
  return key.numbers.every((n) => t.numbers.has(n))
    && key.bare.every((n) => t.bare.has(n))
    && key.latin.every((w) => t.words.includes(w))
    && key.stems.every((s) => t.words.some((w) => w.startsWith(s) && w.length <= s.length + 5));
}

/**
 * What the reader sees next to the poll: its intro, the companion post and the resource's posts of the same story in
 * the last 24 h (newest first). Needs `ctx.previous` for the last two; without it only the intro is read.
 */
export function revealSources(post: AuditPost, ctx: AuditContext): RevealText[] {
  const at = Date.parse(post.publishedAt);
  const out: RevealText[] = [];
  const intro = bodyText(post).trim();
  if (intro) out.push(revealText('вступ до опитування', intro));
  const poll = post.poll!;
  // The poll's story: its question and intro (the options would add the wrong answers as entities).
  const self = storyView({ ...post, text: [poll.question, intro].filter(Boolean).join('\n\n') });
  for (const p of ctx.previous ?? []) {
    const ago = at - Date.parse(p.publishedAt);
    if (ago < 0 || ago > REVEAL_STORY_HOURS * 3_600_000 || p.id === post.id) continue;
    const text = bodyText(p).trim();
    if (!text) continue;
    if (ago <= COMPANION_MINUTES * 60_000) out.push(revealText('пост поруч', text));
    else if (storyMatch(self, storyView(p))) {
      const when = new Date(p.publishedAt);
      out.push(revealText(`пост того ж сюжету від ${localDate(when, post.timezone)} ${localTimeLabel(when, post.timezone)}`, text));
    }
  }
  return out;
}

export interface PollReveal {
  /** Indexes of the options found in at least one source. */
  found: number[];
  /** Where each found option is (first source). */
  where: Map<number, string>;
}

export function findRevealedOptions(options: readonly string[], sources: readonly RevealText[]): PollReveal {
  const where = new Map<number, string>();
  options.forEach((o, i) => {
    const key = optionKey(o);
    const hit = sources.find((s) => optionFoundIn(key, s));
    if (hit) where.set(i, hit.label);
  });
  return { found: [...where.keys()], where };
}

export interface PollAssessment {
  knowledge: boolean;
  /** Why it is a knowledge poll (for the message). */
  why: 'question_word' | 'answer_in_text' | null;
  /** The revealed right answer (a quiz's correct option, or the one option a regular poll's text gives away). */
  revealed: { index: number; where: string } | null;
}

/** The assessment of a poll / quiz post; null for a post without a poll. */
export function assessPoll(post: AuditPost, ctx: AuditContext): PollAssessment | null {
  const poll = post.poll;
  if (!poll || poll.options.length < 2) return null;
  const opinion = isOpinionQuestion(poll.question);
  const reveal = findRevealedOptions(poll.options, revealSources(post, ctx));

  if (poll.kind === 'quiz') {
    const ci = poll.correctIndex;
    // Every option named in the text (a list of candidates) does not tell which one is right.
    const revealed = ci !== undefined && reveal.where.has(ci) && reveal.found.length < poll.options.length
      ? { index: ci, where: reveal.where.get(ci)! } : null;
    return { knowledge: true, why: null, revealed };
  }
  if (opinion) return { knowledge: false, why: null, revealed: null };
  const single = reveal.found.length === 1 ? { index: reveal.found[0], where: reveal.where.get(reveal.found[0])! } : null;
  if (hasQuestionWord(poll.question) && optionsAreNamesOrNumbers(poll.options)) return { knowledge: true, why: 'question_word', revealed: single };
  if (single) return { knowledge: true, why: 'answer_in_text', revealed: single };
  return { knowledge: false, why: null, revealed: null };
}
