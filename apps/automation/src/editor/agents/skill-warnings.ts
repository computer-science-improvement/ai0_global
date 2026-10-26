import { channelLanguage, languageNameUk, languageScript } from '../post/channel-language';

/**
 * Spec 062 FR-007: what a new channel skill says against the channel card, before the owner sees the card. In chat
 * e8c11647 a new skill prescribed English-only captions, which the channel's own `not_ukrainian` lint rejects, and it
 * stated facts «станом на 2026-10-18» that were stale the next day. Both are warnings, never blocks: the model must tell
 * the owner, who decides.
 */

/** Language code → how a skill names it (English and Ukrainian stems). */
const LANGUAGE_NAMES: ReadonlyArray<[string, RegExp]> = [
  ['en', /(?<![\p{L}])(?:english|англійськ\p{L}*)/iu],
  ['uk', /(?<![\p{L}])(?:ukrainian|українськ\p{L}*)/iu],
  ['ru', /(?<![\p{L}])(?:russian|російськ\p{L}*)/iu],
  ['pl', /(?<![\p{L}])(?:polish|польськ\p{L}*)/iu],
  ['de', /(?<![\p{L}])(?:german|німецьк\p{L}*)/iu],
  ['es', /(?<![\p{L}])(?:spanish|іспанськ\p{L}*)/iu],
  ['fr', /(?<![\p{L}])(?:french|французьк\p{L}*)/iu],
  ['it', /(?<![\p{L}])(?:italian|італійськ\p{L}*)/iu],
  ['pt', /(?<![\p{L}])(?:portuguese|португальськ\p{L}*)/iu],
];

/** The sentence speaks of the reader text… */
const READER_TEXT_RE = /(?<![\p{L}])(?:captions?|posts?|text|copy|write|written|підпис\p{L}*|пост\p{L}*|текст\p{L}*|пиши|писати|пишемо|мов\p{L}+)(?![\p{L}])/iu;
/** …and prescribes it («only», «always», «пиши»), rather than describing it. */
const PRESCRIBES_RE = /(?<![\p{L}])(?:only|exclusively|always|must|should|in|лише|тільки|виключно|завжди|мають|має|потрібно|треба|пиши|писати|пишемо|мовою)(?![\p{L}])/iu;
/** Verbatim text the lint does not read as prose (a prompt, a command, a quote, a code block): any language is fine there. */
const VERBATIM_RE = /(?<![\p{L}])(?:code|prompts?|quotes?|quoted|verbatim|command|snippet|код\p{L}*|промпт\p{L}*|цитат\p{L}*|дослівн\p{L}*|команд\p{L}*|переклад\p{L}*|translat\p{L}*)(?![\p{L}])/iu;

const DATE_RES: readonly RegExp[] = [
  /станом\s+на\s+(?:сьогодні|зараз|цей\s+момент|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{1,2}\s+\p{L}+(?:\s+\d{4})?)/iu,
  /as\s+of\s+(?:today|now|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}|\p{L}+\s+\d{1,2}(?:,\s*\d{4})?)/iu,
];

/** Sentences of the body (list items and lines included) with their text. */
const sentences = (body: string) => body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** The language the skill prescribes for reader text whose script the channel's lint would reject, with the sentence. */
export function languageWarning(body: string, card: { language?: string | null } | null | undefined): string | null {
  if (!card) return null;
  const lang = channelLanguage(card);
  const want = languageScript(lang);
  if (!want) return null; // mixed or an unchecked script: the lint does not reject by language
  for (const s of sentences(body)) {
    if (!READER_TEXT_RE.test(s) || !PRESCRIBES_RE.test(s) || VERBATIM_RE.test(s)) continue;
    for (const [code, re] of LANGUAGE_NAMES) {
      if (code === lang || !re.test(s)) continue;
      const script = languageScript(code);
      if (script && script !== want) {
        return `скіл велить писати текст для читачів мовою «${languageNameUk(code)}» («${s.slice(0, 120)}»), а lint каналу вимагає ${languageNameUk(lang)} і відхилить такі пости (${lang === 'uk' ? 'not_ukrainian' : 'wrong_language'}). Скажи власнику; мову каналу змінює лише він (Language у картці каналу), правило в скілі її не вимикає`;
      }
    }
  }
  return null;
}

/** Dated facts in the body: «станом на 2026-10-18», «станом на сьогодні», «as of today». */
export function dateWarning(body: string): string | null {
  for (const re of DATE_RES) {
    const m = re.exec(body);
    if (m) return `скіл містить датований факт («${m[0]}») — він застаріє, а скіл діє постійно. Прибери дату або винеси факт у памʼять/дані; скажи власнику`;
  }
  return null;
}

/** The warnings for a skill body against the channel card (language, dates); empty when it is clean. */
export function skillWarnings(body: string, card: { language?: string | null } | null | undefined): string[] {
  return [languageWarning(body, card), dateWarning(body)].filter((w): w is string => !!w);
}

// ── Spec 069 FR-002: a skill is not a way to change where content comes from ────────────────────────────────────────

/**
 * Review 4: the owner said «бери з X, не бери Y» and the composer wrote skills about it (and never imported anything), so
 * the planner kept pinning the old rows. A change of the content source is an `import_list` card (the dataset, the series
 * bound to it, the rule, the skills to switch off); a skill may say how to USE a dataset — pick a row, keep the prompt
 * verbatim, credit the author — but not WHERE the posts come from.
 */
export type SourceInSkillKind = 'url' | 'provider' | 'dataset';
export interface SourceInSkill { kind: SourceInSkillKind; sentence: string }

const TAKE_RE = /(?<![\p{L}])(?:бер\p{L}*|брат\p{L}*|взят\p{L}*|візьм\p{L}*|тягн\p{L}*|тягт\p{L}*|використ\p{L}*|користу\p{L}*|качай|завантаж\p{L}*|take|takes|use|using|fetch|pull|grab|source|sourced|get|scrape|read)(?![\p{L}])/iu;
const CONTENT_RE = /(?<![\p{L}])(?:пост\p{L}*|контент\p{L}*|промпт\p{L}*|запис\p{L}*|матеріал\p{L}*|новин\p{L}*|рядк\p{L}*|рядок|posts?|content|prompts?|entries|items?|stor(?:y|ies)|articles?|rows?)(?![\p{L}])/iu;
const URL_RE = /https?:\/\/\S+/i;
const API_RE = /(?<![\p{L}])(?:API|апі)(?![\p{L}])/u;
const PROVIDER_RE = /(?<![\p{L}])provider\s*=\s*["']?[\p{L}\p{N}_-]+/iu;
const DATASET_REF_RE = /(?:data:\/\/|library:)[\p{L}\p{N}_-]{2,}|(?:датасет\p{L}*|dataset)\s+["«]?[a-z][a-z0-9_]{2,}/iu;
const ONLY_RE = /(?<![\p{L}])(?:замість|instead\s+of|лише|тільки|only|exclusively|виключно|а\s+не)(?![\p{L}])/iu;

/** The first sentence of the body that prescribes a live content source (a URL / API to take posts from, a `provider=` filter, a dataset to use instead of the series source), or null. */
export function sourceInSkill(body: string): SourceInSkill | null {
  for (const s of sentences(body)) {
    if (PROVIDER_RE.test(s)) return { kind: 'provider', sentence: s.slice(0, 160) };
    const takes = TAKE_RE.test(s) && CONTENT_RE.test(s);
    if (takes && (URL_RE.test(s) || API_RE.test(s))) return { kind: 'url', sentence: s.slice(0, 160) };
    if (takes && DATASET_REF_RE.test(s) && ONLY_RE.test(s)) return { kind: 'dataset', sentence: s.slice(0, 160) };
  }
  return null;
}

/** The tool error for a skill write that prescribes a content source (`edit_my_skill`, the builder's `write_skill`), or null. */
export function sourceRefusal(body: string): { error: 'source_belongs_in_import'; details: string; hint: string } | null {
  const found = sourceInSkill(body);
  if (!found) return null;
  return {
    error: 'source_belongs_in_import',
    details: `скіл велить брати контент із конкретного джерела («${found.sentence}») — це не скіл`,
    hint: 'зміна джерела контенту — це import_list з series (серія, яку привʼязати), stop_using (чого не брати) і disable_skills: одна картка, власник лише ставить позначки й тисне Apply. Скіл може лише пояснювати, як користуватись рядком датасету (вибрати рядок, залишити промпт дослівно, вказати автора)',
  };
}
