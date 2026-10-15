import type { ResourceStyle } from '../style/resource-style';

/**
 * Spec 037 FR-009 (T9): jargon against the audience level. A post for «ordinary people» that retells a research feed
 * («Matryoshka-трюнкація: 768d → 256d», MTEB, MoE, forward pass) loses its reader. Code counts the distinct terms of
 * a list that the post leaves unexplained; over the level's budget → `jargon_over_level` (a warning for the critic).
 * Without `style.audience.level` nothing is counted (the check never guesses the audience).
 */

export type AudienceLevel = NonNullable<ResourceStyle['audience']>['level'];

/**
 * Distinct unexplained terms a post may carry per level. `expert` has no budget (the reader knows the words).
 * Calibrated on the 07–14.10 golden set: the AI Технології news retold from MarkTechPost carry 4–9 unexplained terms,
 * its explainers and news written for people 0–2 (a poll intro of three words, «MoE, параметри, токен», is at 3).
 */
export const JARGON_BUDGET: Record<AudienceLevel, number> = { beginner: 2, general: 5, expert: Infinity };

export const LEVEL_UK: Record<AudienceLevel, string> = { beginner: 'початківці', general: 'широка аудиторія', expert: 'фахівці' };

export interface JargonTerm {
  /** Display name (the critic and the writer see it). */
  term: string;
  /** Every spelling and inflection of the term, one regex (flags gu / giu). */
  re:   RegExp;
}

// Word edges for Cyrillic and Latin alike (JS `\b` knows only ASCII).
const L = '(?<![\\p{L}\\p{N}_])';
const R = '(?![\\p{L}\\p{N}_])';
const t = (term: string, src: string, ci = true): JargonTerm => ({ term, re: new RegExp(`${L}(?:${src})${R}`, ci ? 'giu' : 'gu') });

/**
 * The list (tasks.md T9 plus what the golden set's AI posts use without a word of explanation). Abbreviations are
 * case-sensitive (API, not «api» in a URL), words are not. Generic words that are jargon only sometimes («агент»,
 * «промпт», «модель», «edge») are left out: a false alarm costs the critic's attention.
 */
export const JARGON_TERMS: JargonTerm[] = [
  t('MoE', 'MoE|[Mm]ixture[ -]of[ -][Ee]xperts', false),
  t('embedding', 'embedding\\p{L}*|ембед(?:д)?инг\\p{L}*|ембединг\\p{L}*'),
  t('токени', 'токен(?:и|ів|ам|ами|ах|а|у|ом|і)?|tokens?'),
  t('токенайзер', 'токенайзер\\p{L}*|tokenizer\\p{L}*'),
  t('параметри', 'параметр(?:и|ів|ам|ами|ах|а)?'),
  t('fine-tune', 'fine-?tun\\p{L}*|файн-?тюн\\p{L}*'),
  t('інференс', 'inference|інференс\\p{L}*'),
  t('бенчмарк', 'бенчмарк\\p{L}*|benchmark\\p{L}*|SWE-bench(?: Verified)?'),
  t('ваги моделі', 'ваг(?:и|ами|ах)|open-?weights?|open-ваг\\p{L}*'),
  t('MTEB', 'MTEB', false),
  t('LoRA', 'LoRA|QLoRA', false),
  t('RAG', 'RAG', false),
  t('API', 'API', false),
  t('CLI', 'CLI', false),
  t('SDK', 'SDK', false),
  t('LLM', 'LLMs?', false),
  t('RL', 'RL|RLHF', false),
  t('MCP', 'MCP', false),
  t('контекстне вікно', 'контекстн\\p{L}* вікн\\p{L}*|context window'),
  t('квантизація', 'квантиз\\p{L}*|quantiz\\p{L}*'),
  t('дистиляція', 'дистиляц\\p{L}*|distillation'),
  t('енкодер', 'енкодер\\p{L}*|encoders?'),
  t('пайплайн', 'пайплайн\\p{L}*|pipelines?'),
  t('cosine similarity', 'cosine similarity|косинусн\\p{L}* (?:подібн|схож)\\p{L}*'),
  t('forward pass', 'forward pass'),
  t('batch', 'batch(?:ing)?|батч\\p{L}*'),
  t('cache', 'cache(?: reads?)?'),
  t('temperature / top_p', 'top_p|temperature'),
  t('subagents', 'subagents?|субагент\\p{L}*'),
  t('reverse shell', 'reverse shell'),
  t('pickle', 'pickle|unpickling'),
  t('payload', 'payloads?'),
  t('symlink', 'symlinks?'),
  t('VRAM', 'VRAM|CUDA', false),
];

/** A sentence of the post with its offset (sentences split at . ! ? … before a capital, a quote or a digit, and at line breaks). */
interface Sentence { text: string; start: number }

export function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^\n]+/g;
  for (const line of text.matchAll(re)) {
    const base = line.index ?? 0;
    const s = line[0];
    let from = 0;
    for (const m of s.matchAll(/[.!?…]+(?=\s+[«"(\p{Lu}\p{N}•])/gu)) {
      const end = (m.index ?? 0) + m[0].length;
      out.push({ text: s.slice(from, end), start: base + from });
      from = end;
    }
    out.push({ text: s.slice(from), start: base + from });
  }
  return out.filter((x) => x.text.trim());
}

/** Words that open an explanation of the term just named («тобто», «простими словами», «— це»). */
const EXPLAIN_AFTER = /(?:^|[\s,(])(?:тобто|(?:це|що) означає|іншими словами|простими словами|простіше кажучи|так називають)(?![\p{L}])|[—–]\s*це(?![\p{L}])/iu;
/** A next sentence that explains the previous one («Це місток, через який…», «Тобто…»). */
const EXPLAIN_NEXT = /^\s*(?:Це(?!\s+не(?![\p{L}]))|Тобто|Простіше кажучи|Іншими словами|Простими словами|Інакше кажучи)(?![\p{L}])/u;

/**
 * Is this occurrence of a term explained? The heuristic (spec 037 T9), in order:
 *  1. a parenthesis gloss of two words or more right after the term («MoE (mixture of experts)», «MCP-сервер
 *     (місток до бюджету)»; «MTEB (Code)» is a label, not a gloss), or the term is itself the gloss of a plain word
 *     before it («підрядні агенти (subagents)»);
 *  2. a dash or colon gloss when the term opens its sentence, line or bullet («MCP — USB-порт для ШІ», «• RAG: ШІ
 *     перед відповіддю шукає…» — a glossary); a dash in mid-sentence is punctuation, not a gloss;
 *  3. the rest of the same sentence explains it («…, тобто…», «— це…», «це означає…», «простими словами…»);
 *  4. the next sentence opens with «Це…», «Тобто…», «Простіше кажучи…» and has no figures («Команда YNAB випустила
 *     MCP-сервер. Це місток…»; «Це на 90% дешевше» after a price explains nothing).
 * A term counts as explained when any of its occurrences is.
 */
export function isExplained(text: string, sentences: Sentence[], at: number, end: number): boolean {
  // The whole word the term is part of («MCP-сервер», «токенів»).
  let e = end;
  while (e < text.length && /[\p{L}\p{N}_-]/u.test(text[e])) e++;
  const after = text.slice(e, e + 200);
  const gloss = /^\s*\(([^)]{1,120})\)/.exec(after);
  if (gloss && gloss[1].trim().split(/\s+/).length >= 2) return true;
  const before = text.slice(Math.max(0, at - 2), at);
  if (/\(\s*$/.test(before)) {
    const close = text.indexOf(')', end);
    const pre = text.slice(Math.max(0, at - 40), at);
    if (close > 0 && /\p{L}{3,}\s*\(\s*$/u.test(pre)) return true;
  }
  const i = sentences.findIndex((s) => at >= s.start && at < s.start + s.text.length);
  if (i < 0) return false;
  const s = sentences[i];
  // The term opens its sentence, line or bullet: «MCP — USB-порт для ШІ», «• RAG: ШІ шукає…».
  const opens = /^\s*(?:[•\-*]|\d+[.)])?\s*$/u.test(text.slice(s.start, at));
  if (opens && /^\s*[—–:]\s/.test(after)) return true;
  if (EXPLAIN_AFTER.test(s.text.slice(e - s.start))) return true;
  // An explanation is words, not figures: «Це на 90% дешевше…» after a price line explains nothing.
  const next = sentences[i + 1];
  return !!next && EXPLAIN_NEXT.test(next.text) && !/\p{N}/u.test(next.text);
}

export interface JargonCount {
  /** Distinct terms the post leaves unexplained, in order of first use. */
  unexplained: string[];
  /** Distinct terms the post explains. */
  explained:   string[];
}

/** The listed terms of a text, split into explained and unexplained (by the heuristic of `isExplained`). */
export function jargonOf(text: string, terms: readonly JargonTerm[] = JARGON_TERMS): JargonCount {
  const sentences = sentencesOf(text);
  const first = new Map<string, number>();
  const explained = new Set<string>();
  for (const term of terms) {
    for (const m of text.matchAll(term.re)) {
      const at = m.index ?? 0;
      if (!first.has(term.term)) first.set(term.term, at);
      if (isExplained(text, sentences, at, at + m[0].length)) explained.add(term.term);
    }
  }
  const order = [...first.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  return { unexplained: order.filter((k) => !explained.has(k)), explained: order.filter((k) => explained.has(k)) };
}

/** The level's verdict on a text: null when within the budget or without a level. */
export function jargonOverLevel(text: string, level: AudienceLevel | null | undefined): { level: AudienceLevel; budget: number; terms: string[] } | null {
  if (!level) return null;
  const budget = JARGON_BUDGET[level];
  if (!Number.isFinite(budget)) return null;
  const { unexplained } = jargonOf(text);
  return unexplained.length > budget ? { level, budget, terms: unexplained } : null;
}
