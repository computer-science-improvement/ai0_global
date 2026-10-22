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
