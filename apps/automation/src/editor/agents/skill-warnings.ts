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
/**
 * The URL or API is where posts are taken FROM: a «from» marker (з / from / via / через …) within a few words before it.
 * A link put INTO a post («use the link https://t.me/x at the end», «credit the author with a link to https://…») has no such
 * marker; one that does («кнопку з посиланням https://…») is a link word before the URL, which LINK_URL_RE catches.
 */
const FROM_SRC_RE = /(?<![\p{L}])(?:from|з|із|зі|від|via|through|using|через|використовуючи|за\s+допомогою)\s+(?:[^\s.,;]+\s+){0,3}(?:https?:\/\/|API(?![\p{L}])|апі(?![\p{L}]))/iu;
/** A link, a button or a CTA right before the URL: the URL is shown in the post, not read from. */
const LINK_URL_RE = /(?<![\p{L}])(?:посилан\p{L}*|лінк\p{L}*|links?|кнопк\p{L}*|buttons?|cta)\s+(?:\S+\s+){0,3}https?:\/\//iu;
const PROVIDER_RE = /(?<![\p{L}])provider\s*=\s*["']?[\p{L}\p{N}_-]+/iu;
const DATASET_REF_RE = /(?:data:\/\/|library:)[\p{L}\p{N}_-]{2,}|(?:датасет\p{L}*|dataset)\s+["«]?[a-z][a-z0-9_]{2,}/iu;
const ONLY_RE = /(?<![\p{L}])(?:замість|instead\s+of|лише|тільки|only|exclusively|виключно|а\s+не)(?![\p{L}])/iu;

/** The first sentence of the body that prescribes a live content source (a URL / API to take posts from, a `provider=` filter, a dataset to use instead of the series source), or null. */
export function sourceInSkill(body: string): SourceInSkill | null {
  for (const s of sentences(body)) {
    if (PROVIDER_RE.test(s)) return { kind: 'provider', sentence: s.slice(0, 160) };
    const takes = TAKE_RE.test(s) && CONTENT_RE.test(s);
    if (takes && FROM_SRC_RE.test(s) && !LINK_URL_RE.test(s)) return { kind: 'url', sentence: s.slice(0, 160) };
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
// The `u` flag matters: without it `\p{L}` is just the letters p, L, { and }, the "not after a letter" lookbehind does nothing and
// an e-mail («owner@gmail.com») or the tail of a host («ompthero.com») yields junk tokens.
const BARE_HOST_RE = /(?<![\p{L}\p{N}@/.-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|app|dev|co|ua|info|me|tv|xyz|news|art|so|gg|pro|site|online|shop|cc|ru|de|uk|fr|pl|eu|us|ly))(?![\p{L}\p{N}-])/giu;
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

export function sourceTokensIn(text: string): string[] {
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
  /**
   * Spec 073 FR-012: the part of `positive` the skill PRESCRIBES — a `data://` / `library:` key or a `provider=` value anywhere,
   * a host only in a clause that takes or names a source (not a link shown in a post). A host in a credit line is not here.
   */
  prescribed: Set<string>;
}

/** A clause that takes a source or names one («бери…», «джерело: …», «source»): its hosts are prescribed, not mentioned. */
const TAKING_RE = new RegExp(`${TAKE_RE.source}|(?<![\\p{L}])джерел\\p{L}*`, 'iu');

/** «не бери X, тепер бери з Y»: a comma, dash or colon before a positive take verb ends the negated clause and starts a new one. */
const CLAUSE_END_RE = /\s*(?:,|—|–|\s-\s|:)\s*(?=(?:(?:а|але|тепер|now|but|натомість|and)\s+)?(?:бер\p{L}*|бра\p{L}*|взя\p{L}*|візьм\p{L}*|використ\p{L}*|користу\p{L}*|use|take|fetch|pull|source|get)(?![\p{L}]))/iu;
/** «X замість Y» / «X instead of Y»: only what comes after the marker is ruled out. */
const INSTEAD_RE = /(?<![\p{L}])(?:замість|instead\s+of|rather\s+than)(?![\p{L}])/iu;
const POSITIVE_VERB_RE = /(?<![\p{L}])(?:бер\p{L}*|бра\p{L}*|взя\p{L}*|візьм\p{L}*|використ\p{L}*|користу\p{L}*|use|take|fetch|pull|get)(?![\p{L}])/iu;

function profileOf(body: string): SourceProfile {
  const positive = new Set<string>();
  const negated = new Set<string>();
  const rule = (text: string) => {
    for (const t of sourceTokensIn(text)) negated.add(t);
    for (const w of text.toLowerCase().match(WORD4_RE) ?? []) negated.add(w);
  };
  const prescribed = new Set<string>();
  const use = (text: string) => {
    const taking = TAKING_RE.test(text) && !LINK_URL_RE.test(text);
    for (const t of sourceTokensIn(text)) { positive.add(t); if (taking) prescribed.add(t); }
    for (const m of text.matchAll(SOURCE_KEY_RE)) prescribed.add(m[1].toLowerCase());
    for (const m of text.matchAll(PROVIDER_VALUE_RE)) prescribed.add(m[1].toLowerCase());
  };
  for (const clause of sentences(body).flatMap((s) => s.split(/\s*;\s*/)).flatMap((s) => s.split(CLAUSE_END_RE))) {
    if (!NEGATION_RE.test(clause)) { use(clause); continue; }
    const instead = INSTEAD_RE.exec(clause);
    if (instead && !NEGATION_RE.test(clause.replace(INSTEAD_RE, ' '))) {
      // «Пиши про nanobanana замість prompthero»: the part before the marker is what to use, the part after is ruled out (up to a take verb).
      use(clause.slice(0, instead.index));
      const after = clause.slice(instead.index + instead[0].length);
      const verb = after.search(POSITIVE_VERB_RE);
      rule(verb < 0 ? after : after.slice(0, verb));
      if (verb >= 0) use(after.slice(verb));
      continue;
    }
    rule(clause);
  }
  return { positive, negated, prescribed };
}

/**
 * Words that name a kind of post, not a source: `prompts_chat` or `recipes_ua` starts with one, and an owner who says «не бери
 * prompts» has not ruled out a dataset called `prompts_chat`. Only an exact match counts for these.
 */
const FORMAT_HEADS = new Set(['prompt', 'prompts', 'recipe', 'recipes', 'quote', 'quotes', 'photo', 'photos', 'video', 'videos', 'memes', 'story', 'stories', 'news', 'digest', 'digests', 'quiz', 'quizzes', 'polls', 'items', 'posts', 'entries', 'articles']);

/** The positive tokens that a negated token rules out: the same word, or the first part of a `nanobanana_prompts`-style key (not a generic format word). */
function ruledOut(negated: ReadonlySet<string>, positive: ReadonlySet<string>): string[] {
  return [...positive].filter((p) => {
    if (negated.has(p)) return true;
    const head = p.split(/[_-]/)[0];
    return head.length >= 5 && !FORMAT_HEADS.has(head) && negated.has(head);
  });
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

export function topicOf(name: string, description: string, body: string): Set<string> {
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
export function skillConflicts(
  newBody: string, existing: readonly ConflictCandidate[],
  opts: { name?: string; description?: string; keep?: readonly string[] } = {},
): SkillConflict[] {
  const mine = profileOf(newBody);
  const myTopic = topicOf(opts.name ?? '', opts.description ?? '', newBody);
  // `keep`: the sources the change STARTS using (the dataset an import creates). A skill that is about one of them is the skill
  // for the new source: it is never proposed for switching off, whatever else the owner's words ruled out.
  const keep = new Set((opts.keep ?? []).flatMap((k) => [k.toLowerCase(), k.toLowerCase().split(/[_-]/)[0]]).filter((k) => k.length >= 4));
  const hard: SkillConflict[] = [];
  const soft: SkillConflict[] = [];
  for (const e of existing) {
    if (opts.name && e.name === opts.name) continue;
    const theirs = profileOf(e.body);
    if (keep.size && [...theirs.positive].some((p) => keep.has(p) || keep.has(p.split(/[_-]/)[0]))) continue;
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

// ── Spec 069 FR-007: a skill must not tell the agent to call read material its own ─────────────────────────────────

/**
 * Review 4: a prompt copied from the library went out as `origin=original`. The lint now rejects a post that shares a run
 * of 80 chars with a source the agent read (`origin_mismatch`); a skill that PRESCRIBES `origin=original` for material read
 * from a page, a feed, a document or the library sends the agent straight into that error, so the write is refused.
 */
const ORIGIN_ORIGINAL_RE = /(?<![\p{L}])origin\s*(?:=|:|→|->)?\s*["'«`]*original(?![\p{L}])/iu;
const ORIGIN_OTHER_RE = /(?<![\p{L}])origin\s*(?:=|:)\s*["'«`]*(?:library|external)(?![\p{L}])/iu;
const READ_SOURCE_RE = /(?<![\p{L}\p{N}_])(?:web_fetch|fetch_feed|fetch_api|read_doc|find_in_doc|query_data|search_library|library_ref)(?![\p{L}\p{N}_])|data:\/\/|library:|https?:\/\/|(?<![\p{L}])(?:бібліотек\p{L}*|датасет\p{L}*|dataset|library|прочитан\p{L}*|завантажен\p{L}*|сторінк\p{L}*|рядк\p{L}*|рядок)(?![\p{L}])/iu;
/** «не став original», «without a source»: the sentence rules the pairing out (or is about own text). */
const RULES_OUT_RE = /(?<![\p{L}])(?:не|без|ніколи|never|not|without|no|don'?t)(?![\p{L}])/iu;
const LIST_ITEM_RE = /^(?:[-*•]|\d+[.)])\s/;

export interface OriginWithSource { sentence: string }

/** The first sentence (a list item reads its lead line too) that prescribes `origin=original` together with a fetched or library source, or null. */
export function originWithSource(body: string): OriginWithSource | null {
  const list = sentences(body);
  for (let k = 0; k < list.length; k++) {
    const s = list[k];
    if (!ORIGIN_ORIGINAL_RE.test(s) || ORIGIN_OTHER_RE.test(s) || RULES_OUT_RE.test(s)) continue;
    const lead = LIST_ITEM_RE.test(s) && k > 0 ? list[k - 1] : '';
    if (READ_SOURCE_RE.test(s) || (lead && READ_SOURCE_RE.test(lead) && !RULES_OUT_RE.test(lead))) return { sentence: s.slice(0, 160) };
  }
  return null;
}

/** The tool error for a skill write that prescribes `origin=original` for read material (`edit_my_skill`, `write_skill`), or null. */
export function originRefusal(body: string): { error: 'origin_original_with_source'; details: string; hint: string } | null {
  const found = originWithSource(body);
  if (!found) return null;
  return {
    error: 'origin_original_with_source',
    details: `скіл велить ставити origin=original на матеріал, який агент бере з джерела («${found.sentence}») — lint відхилить такий пост (origin_mismatch)`,
    hint: 'матеріал зі сторінки чи фіду — origin=external + source.url; рядок бібліотеки — origin=library + library_ref; origin=original лише для власного тексту, який не повторює прочитане',
  };
}

// ── Spec 073 FR-012: a skill against the series the agent must run ─────────────────────────────────────────────────

/**
 * What a required series reads, as a skill write sees it (`SeriesSource` of kind library, feed or api, mode `required`):
 * the series name, the kind and the dataset key, feed ref (an id or a URL) or API name. `format` and `brief` only help to
 * tell which series a skill is about.
 */
export interface SeriesSourceFact {
  series:  string;
  kind:    'library' | 'feed' | 'api';
  ref:     string;
  format?: string;
  brief?:  string;
}

export interface SeriesSourceConflict {
  code:   'series_source_conflict';
  /** The series (names joined with «, » when the skill is about several of them). */
  series: string;
  /** `other_source`: the skill tells the agent to use a source no series reads. `rules_out_source`: it rules out one a series reads. `original_with_source`: it sets origin=original while the series reads a library or feed. */
  reason: 'other_source' | 'rules_out_source' | 'original_with_source';
  tokens: string[];
  /** English, one line. */
  detail: string;
}

/** The tokens a series' source goes by in a skill text: a dataset key or an API name as written, a feed id, or the host label of a feed URL. */
export function seriesSourceTokens(f: Pick<SeriesSourceFact, 'kind' | 'ref'>): string[] {
  const ref = f.ref.trim().toLowerCase();
  if (!ref) return [];
  const out = new Set<string>();
  if (f.kind === 'feed') for (const t of sourceTokensIn(f.ref)) out.add(t);
  if (!/^https?:\/\//.test(ref)) out.add(ref);
  return [...out];
}

const seriesSourceLabelOf = (f: Pick<SeriesSourceFact, 'kind' | 'ref'>) => `${f.kind}:${f.ref}`;

/** The same source: equal, or the same first part of a key (`nanobanana` / `nanobanana_prompts`) unless that part only names a kind of post. */
function sameSource(a: string, b: string): boolean {
  if (a === b) return true;
  const ha = a.split(/[_-]/)[0];
  return ha === b.split(/[_-]/)[0] && ha.length >= 5 && !FORMAT_HEADS.has(ha);
}

/** A sentence that gives origin=original to material without saying it is the agent's own text. */
const OWN_TEXT_RE = /(?<![\p{L}])(?:власн\p{L}*|свій|свого|своє|свої|своїх|own|самостійн\p{L}*|your\s+own)(?![\p{L}])/iu;

/** The first sentence that prescribes origin=original with no negation, no other origin and no mention of own text; or null. */
function prescribedOriginal(body: string): string | null {
  for (const s of sentences(body)) {
    if (ORIGIN_ORIGINAL_RE.test(s) && !ORIGIN_OTHER_RE.test(s) && !RULES_OUT_RE.test(s) && !OWN_TEXT_RE.test(s)) return s.slice(0, 160);
  }
  return null;
}

/**
 * I14 / FR-012: what a skill body says against the required series of its agent. Pure; the caller passes the series sources
 * (`SkillStore`'s `seriesSources` port, 072's doctor). A skill is judged against the series it is about — the only one when
 * the agent has one, else those that share a format or a name word with it (`opts.name` / `description` help to find them).
 * Built on `profileOf`, `ruledOut` and `ORIGIN_ORIGINAL_RE` of the checks above, not beside them.
 */
export function seriesSourceConflict(
  body: string, series: readonly SeriesSourceFact[], opts: { name?: string; description?: string } = {},
): SeriesSourceConflict[] {
  if (!series.length) return [];
  const mine = topicOf(opts.name ?? '', opts.description ?? '', body);
  const about = series.length === 1 ? [...series] : series.filter((f) => [...topicOf(f.series, f.format ?? '', f.brief ?? '')].some((w) => mine.has(w)));
  if (!about.length) return [];
  const names = [...new Set(about.map((f) => f.series))].join(', ');
  const labels = [...new Set(about.map(seriesSourceLabelOf))].join(', ');
  const own = about.flatMap(seriesSourceTokens);
  const profile = profileOf(body);
  const out: SeriesSourceConflict[] = [];
  const other = [...profile.prescribed].filter((t) => !own.some((o) => sameSource(o, t)));
  if (other.length) {
    out.push({
      code: 'series_source_conflict', series: names, reason: 'other_source', tokens: other,
      detail: `the skill tells the agent to use ${other.map((t) => `"${t}"`).join(', ')}, but series ${names} reads ${labels}`,
    });
  }
  const ruled = ruledOut(profile.negated, new Set(own));
  if (ruled.length) {
    out.push({
      code: 'series_source_conflict', series: names, reason: 'rules_out_source', tokens: ruled,
      detail: `the skill rules out ${ruled.map((t) => `"${t}"`).join(', ')}, which series ${names} reads (${labels})`,
    });
  }
  const original = about.some((f) => f.kind === 'library' || f.kind === 'feed') ? prescribedOriginal(body) : null;
  if (original) {
    out.push({
      code: 'series_source_conflict', series: names, reason: 'original_with_source', tokens: ['origin=original'],
      detail: `the skill sets origin=original («${original}»), but series ${names} reads ${labels}; material it reads goes out as origin=library or origin=external, and the lint rejects origin=original on it (origin_mismatch)`,
    });
  }
  return out;
}

export type SkillWriteProblemCode = 'source_belongs_in_import' | 'origin_original_with_source' | 'series_source_conflict';

/** One thing wrong with a skill that is being written: the tool-error shape an agent is refused with, and the line the owner is warned with. */
export interface SkillWriteProblem {
  code:    SkillWriteProblemCode;
  refusal: { error: SkillWriteProblemCode; details: string; hint: string };
  /** English, for the owner. */
  warning: string;
}

/**
 * Every path that writes a skill runs these (`SkillStore.writeAgentSkill`): the checks the chat tools always ran
 * (`sourceRefusal`, `originRefusal`) and, given the agent's required series, `seriesSourceConflict`. An agent's write is
 * refused with the first problem's `refusal`; the owner's is saved and carries the `warning`s.
 */
export function skillWriteProblems(
  body: string, series: readonly SeriesSourceFact[] = [], opts: { name?: string; description?: string } = {},
): SkillWriteProblem[] {
  const out: SkillWriteProblem[] = [];
  const place = sourceRefusal(body);
  const found = sourceInSkill(body);
  if (place && found) {
    out.push({ code: place.error, refusal: place, warning: `The skill tells the agent where to take posts from («${found.sentence}»). A change of source is an import card, not a skill.` });
  }
  const origin = originRefusal(body);
  const orig = originWithSource(body);
  if (origin && orig) {
    out.push({ code: origin.error, refusal: origin, warning: `The skill sets origin=original on material the agent reads («${orig.sentence}»); the lint rejects such a post (origin_mismatch).` });
  }
  for (const c of seriesSourceConflict(body, series, opts)) {
    // origin=original on read material is already said above; the series adds only what it alone can see.
    if (c.reason === 'original_with_source' && origin) continue;
    out.push({
      code: 'series_source_conflict', warning: `The skill contradicts a series: ${c.detail}.`,
      refusal: {
        error: 'series_source_conflict', details: c.detail,
        hint: 'the series decides where its posts come from — change the series source (the Schedule tab) or reword the skill so it only says how to use the series\' rows (pick the row, keep the prompt verbatim, credit the author)',
      },
    });
  }
  return out;
}
