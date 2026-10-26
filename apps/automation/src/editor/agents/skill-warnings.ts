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

// ── Spec 069 FR-003: a new skill against the skills the agent already has ──────────────────────────────────────────

/**
 * Review 4: skill 7a054c4f «Фільтр provider=prompthero» stayed on while d3ef5edb «PromptHero не використовую» was added, so
 * the planner kept pinning the rows the owner had dropped. When a skill is written (or a source is dropped with
 * `import_list`), the skills it contradicts are found here, in code, and ride on the same card as `detach_skill` items.
 *
 * A token is a SOURCE: the second-level label of a host (`prompthero.com` → `prompthero`), a `data://` / `library:` key, a
 * `provider=` value. A clause (a sentence, a line, a half of `;`) holds a negation marker or it does not; its source tokens
 * are negated or positive accordingly, and a negated clause also gives its bare words (4+ letters, lower-case), because the
 * owner writes «PromptHero не використовую», not «provider=prompthero не використовую».
 */
export interface ConflictCandidate { name: string; description?: string | null; body: string }
export interface SkillConflict {
  name:   string;
  /** `hard`: one skill rules out a source the other tells the agent to use. `soft`: they name different sources for the same format. */
  kind:   'hard' | 'soft';
  /** The source tokens that meet (hard), or the format / series words the two skills share (soft). */
  tokens: string[];
  /** English, for the card line. */
  reason: string;
}

/** «не бери / не використовуй / не з», «never», «don't use», «avoid», «замість», «instead of», «заборонено»… */
const NEGATION_RE = /(?<![\p{L}])(?:не\s+(?:бер\p{L}*|бра\p{L}*|взя\p{L}*|візьм\p{L}*|використ\p{L}*|користу\p{L}*|тягн\p{L}*|тягт\p{L}*|качай\p{L}*|завантаж\p{L}*|застосову\p{L}*|з|із|від)|ніколи|заборон\p{L}*|замість|припин\p{L}*|never|(?:don'?t|do\s+not|doesn'?t|must\s+not|mustn'?t|should\s+not|shouldn'?t)\s+(?:use|take|fetch|pull|source|get|scrape|read|rely)|stop\s+using|avoid|forbidden|instead\s+of|rather\s+than|no\s+longer)(?![\p{L}])/iu;
const URL_HOST_RE = /https?:\/\/(?:www\.)?([a-z0-9][a-z0-9.-]*[a-z0-9])/gi;
/** A host written without a scheme: only the TLDs people actually write («prompthero.com»), so «skill.md» and «e.g.» are not sources. */
const BARE_HOST_RE = /(?<![\p{L}\p{N}@/.-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|app|dev|co|ua|info|me|tv|xyz|news|art|so|gg|pro|site|online|shop|cc|ru|de|uk|fr|pl|eu|us|ly))(?![\p{L}\p{N}-])/gi;
const SOURCE_KEY_RE = /(?:data:\/\/|library:)([\p{L}\p{N}_-]{2,})/giu;
const PROVIDER_VALUE_RE = /(?<![\p{L}])provider\s*=\s*["']?([\p{L}\p{N}_-]+)/giu;
const WORD4_RE = /\p{L}{4,}/gu;

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
/** `www.prompthero.com` → `prompthero`; `bbc.co.uk` → `bbc`. */
function hostLabel(host: string): string | null {
  const parts = host.toLowerCase().split('.').filter((p) => p && p !== 'www');
  if (parts.length < 2) return parts[0] ?? null;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  return parts.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(sld) ? parts[parts.length - 3] : sld;
}

function sourceTokensIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOST_RE)) { const l = hostLabel(m[1]); if (l) out.add(l); }
  for (const m of text.matchAll(BARE_HOST_RE)) { const l = hostLabel(m[1]); if (l) out.add(l); }
  for (const m of text.matchAll(SOURCE_KEY_RE)) out.add(m[1].toLowerCase());
  for (const m of text.matchAll(PROVIDER_VALUE_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

interface SourceProfile {
  /** Source tokens outside negated clauses: what the skill tells the agent to use. */
  positive: Set<string>;
  /** Source tokens and bare words inside negated clauses: what it rules out. */
  negated:  Set<string>;
}

function profileOf(body: string): SourceProfile {
  const positive = new Set<string>();
  const negated = new Set<string>();
  for (const clause of sentences(body).flatMap((s) => s.split(/\s*;\s*/))) {
    const tokens = sourceTokensIn(clause);
    if (NEGATION_RE.test(clause)) {
      for (const t of tokens) negated.add(t);
      for (const w of clause.toLowerCase().match(WORD4_RE) ?? []) negated.add(w);
    } else {
      for (const t of tokens) positive.add(t);
    }
  }
  return { positive, negated };
}

/** The positive tokens that a negated token rules out: the same word, or the first part of a `nanobanana_prompts`-style key. */
function ruledOut(negated: ReadonlySet<string>, positive: ReadonlySet<string>): string[] {
  return [...positive].filter((p) => negated.has(p) || (negated.has(p.split(/[_-]/)[0]) && p.split(/[_-]/)[0].length >= 5));
}

/** Format words a skill and a series are named by: two skills about the same format that name different sources contradict each other softly. */
const FORMAT_WORDS: ReadonlyArray<[string, RegExp]> = [
  ['prompt', /(?<![\p{L}])(?:prompts?|промпт\p{L}*)/iu],
  ['recipe', /(?<![\p{L}])(?:recipes?|рецепт\p{L}*)/iu],
  ['quiz', /(?<![\p{L}])(?:quiz\p{L}*|poll\p{L}*|вікторин\p{L}*|опитуван\p{L}*)/iu],
  ['news', /(?<![\p{L}])(?:news|новин\p{L}*)/iu],
  ['photo', /(?<![\p{L}])(?:photos?|фото\p{L}*|світлин\p{L}*)/iu],
  ['meme', /(?<![\p{L}])(?:memes?|мем\p{L}*)/iu],
  ['video', /(?<![\p{L}])(?:videos?|відео|reels?|shorts?)(?![\p{L}])/iu],
  ['story', /(?<![\p{L}])(?:stor(?:y|ies)|історі\p{L}*)/iu],
  ['digest', /(?<![\p{L}])(?:digests?|дайджест\p{L}*)/iu],
  ['quote', /(?<![\p{L}])(?:quotes?|цитат\p{L}*)/iu],
];
/** Words of a skill name that say nothing about the series. */
const NAME_STOP = new Set(['skill', 'skills', 'channel', 'rules', 'rule', 'style', 'voice', 'canal', 'скіл', 'канал', 'правила', 'стиль', 'source', 'джерело']);

function topicOf(name: string, description: string, body: string): Set<string> {
  const out = new Set<string>();
  const hay = `${name}\n${description}\n${body}`;
  for (const [word, re] of FORMAT_WORDS) if (re.test(hay)) out.add(word);
  // A word of the name is a series word unless it is a stop word or only a longer spelling of a format word already there («prompts», «prompthero»).
  for (const w of name.toLowerCase().match(/\p{L}{5,}/gu) ?? []) if (!NAME_STOP.has(w) && ![...out].some((f) => w.startsWith(f))) out.add(w);
  return out;
}

/**
 * The existing skills a new skill body contradicts. Hard: its negated tokens meet an existing skill's positive source
 * tokens, or the reverse (the existing skill rules out what the new one uses). Soft: both name sources, different ones,
 * for the same format or series word. Pure; the caller picks the candidates (enabled, not builtin or safety, not the same name).
 */
export function skillConflicts(newBody: string, existing: readonly ConflictCandidate[], opts: { name?: string; description?: string } = {}): SkillConflict[] {
  const mine = profileOf(newBody);
  const myTopic = topicOf(opts.name ?? '', opts.description ?? '', newBody);
  const hard: SkillConflict[] = [];
  const soft: SkillConflict[] = [];
  for (const e of existing) {
    if (opts.name && e.name === opts.name) continue;
    const theirs = profileOf(e.body);
    const ruledOutByNew = ruledOut(mine.negated, theirs.positive);
    const ruledOutByOld = ruledOut(theirs.negated, mine.positive);
    if (ruledOutByNew.length || ruledOutByOld.length) {
      const tokens = [...new Set([...ruledOutByNew, ...ruledOutByOld])];
      hard.push({
        name: e.name, kind: 'hard', tokens,
        reason: ruledOutByNew.length
          ? `it tells the agent to use ${ruledOutByNew.map((t) => `"${t}"`).join(', ')}, which the new text rules out`
          : `it rules out ${ruledOutByOld.map((t) => `"${t}"`).join(', ')}, which the new skill tells the agent to use`,
      });
      continue;
    }
    if (!mine.positive.size || !theirs.positive.size) continue;
    if ([...mine.positive].some((t) => theirs.positive.has(t))) continue; // the same source: nothing to choose between
    const shared = [...topicOf(e.name, e.description ?? '', e.body)].filter((w) => myTopic.has(w));
    if (shared.length) {
      soft.push({
        name: e.name, kind: 'soft', tokens: shared,
        reason: `it names other sources (${[...theirs.positive].slice(0, 3).map((t) => `"${t}"`).join(', ')}) for the same ${shared.slice(0, 2).map((w) => `"${w}"`).join(' / ')}`,
      });
    }
  }
  return [...hard, ...soft];
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
