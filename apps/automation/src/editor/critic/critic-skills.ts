import { SkillLibrary, isOptionalSkill, type Skill, type SkillSource } from '../skills/skill-library';
import type { EditorCard } from '../card';
import type { EditorSlot } from '../repo/editor-plans.repository';

/**
 * Spec 037 FR-012 (T12): the critic judges with the writer's skills. A pure, deterministic selection of the skills
 * a post is written by — the resource tone skills, the post's format skill, the topic skills of its content type and
 * `proper-nouns-terms` — and their compression to rules within a char budget (examples, code fences and long tables
 * dropped). Exported for the writer too; the critic inlines the result in its system prompt (per resource, so it caches).
 */

/** Content types that bring topic skills. */
export type ContentType = 'deals' | 'news';

/** Topic skills per content type (in this order). */
export const TOPIC_SKILLS: Readonly<Record<ContentType, readonly string[]>> = {
  deals: ['deals-giveaways'],
  news:  ['news-followups', 'fact-check'],
};

/** Every post: brand, product and people names, abbreviations, units. */
export const ALWAYS_SKILLS = ['proper-nouns-terms'] as const;

/**
 * Chars of compressed skills in the critic's system prompt. The rubric and voice-core take ≈ 7.4k chars; a typical
 * selection (tone ≈ 1.3k, a format ≈ 1–2.8k, a topic ≈ 2.1–5.8k, proper-nouns-terms ≈ 1.9k, compressed) needs ≈ 8–10k,
 * so the whole system prompt stays ≤ CRITIC_SYSTEM_MAX (≈ 7k tokens, with the names that did not fit) — less than the writer's (8k inline skills,
 * voice-core, card, memory) and far below the context of every model 034 runs.
 */
export const CRITIC_SKILLS_BUDGET = 10_000;
/** The ceiling of the critic's whole system prompt (rubric + voice-core + the skills section). */
export const CRITIC_SYSTEM_MAX = 20_000;

/** The format skill of a post format (Telegram and native platform formats); null for plain text / photo. */
const FORMAT_SKILL: Readonly<Record<string, string>> = {
  poll: 'format-poll-quiz', quiz: 'format-poll-quiz',
  longread: 'format-longread',
  carousel: 'format-carousel', ig_carousel: 'format-carousel', th_carousel: 'format-carousel',
  album: 'format-album-slider', fb_album: 'format-album-slider',
  video: 'format-video',
};

export function formatSkillOf(format: string | null | undefined): string | null {
  return (format && FORMAT_SKILL[format]) || null;
}

/** Skills a resource list never brings to the critic: role workflows (it has its own rubric) and voice-core (always inlined). */
const NOT_RESOURCE = /^editor-[a-z]+-workflow$|^voice-core$/;

/** fetch_api sources and domains of stores / giveaway aggregators: a post from them is a deal or a giveaway. */
const DEAL_SOURCES = new Set(['gamerpower_giveaways', 'steam_deals', 'epic_free_games']);
const DEAL_DOMAINS = /(^|\.)(gamerpower\.com|store\.steampowered\.com|epicgames\.com|gog\.com|humblebundle\.com|fanatical\.com|cheapshark\.com|isthereanydeal\.com|indiegala\.com)$/i;
const DEAL_WORDS = /роздач|знижк|розпродаж|промокод|giveaway|free to keep|\bdeals?\b|\bsale\b/iu;
/** News feeds (fetch_api) and words of a news brief / topic. */
const NEWS_SOURCES = new Set(['spaceflight_news']);
const NEWS_WORDS = /новин|news|анонс|оголоси|представил|презентаці|реліз|вийшл|оновлення:|breaking/iu;

/** What tells the content type of a post (all optional; the more, the better). */
export interface ContentSignals {
  /** Slot sources: live sources and source hints — `api:<name>`, `feed:<id>`, feed URLs, card source ids. */
  sources?:   ReadonlyArray<string | null | undefined>;
  /** The post's source URL (PostSpec `source.url`). */
  sourceUrl?: string | null;
  /** Topic, angle, the live brief, the series name, the post title — scanned for keywords. */
  text?:      ReadonlyArray<string | null | undefined>;
  /** A live slot (spec 034 FR-010: the executor takes the freshest item of a feed — a news slot). */
  live?:      boolean;
}

const hostOf = (u: string): string | null => {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
};
const apiName = (s: string): string => s.replace(/^api:/, '').trim().toLowerCase();

/** The content types of a post, deterministic: deals before news; both may hold (a giveaway from a news feed). */
export function detectContentTypes(s: ContentSignals): ContentType[] {
  const sources = (s.sources ?? []).filter((x): x is string => typeof x === 'string' && !!x.trim());
  const text = (s.text ?? []).filter((x): x is string => typeof x === 'string' && !!x.trim()).join('\n');
  // A library_ref (`data://…`) is not a web source: neither a store nor a news site.
  const web = s.sourceUrl && /^https?:\/\//i.test(s.sourceUrl) ? s.sourceUrl : null;
  const urls = [...sources.filter((x) => /^https?:\/\//i.test(x)), ...(web ? [web] : [])];
  const dealHost = urls.some((u) => { const h = hostOf(u); return !!h && DEAL_DOMAINS.test(h); });
  const deals = sources.some((x) => DEAL_SOURCES.has(apiName(x))) || dealHost || DEAL_WORDS.test(text);
  const feed = sources.some((x) => /^feed:/i.test(x) || NEWS_SOURCES.has(apiName(x)) || (/^https?:\/\//i.test(x) && !DEAL_DOMAINS.test(hostOf(x) ?? '')));
  // A live slot of a deal source is a deal, not a news item; an external non-store source is a news source.
  const news = NEWS_WORDS.test(text) || feed || (!!s.live && !deals) || (!!web && !DEAL_DOMAINS.test(hostOf(web) ?? ''));
  const out: ContentType[] = [];
  if (deals) out.push('deals');
  if (news) out.push('news');
  return out;
}

export interface SkillSelectionInput {
  /** The resource's skills: the card's `skills` and the `tone-*` skills attached to its agent (spec 034 FR-014). */
  resourceSkills?: ReadonlyArray<string>;
  format:          string;
  /** `telegram`, `instagram`…: a native platform post also gets `platform-<platform>`. */
  platform?:       string | null;
  /** Explicit content types; else detected from `signals`. */
  contentTypes?:   ReadonlyArray<ContentType>;
  signals?:        ContentSignals;
}

/**
 * The ordered, de-duplicated skill names a post is written by: the resource tone skills, the platform and format
 * skills, the topic skills of its content type, `proper-nouns-terms`, then the resource's other skills (the order
 * is also the budget priority: what the critic judges by comes first).
 */
export function selectPostSkills(i: SkillSelectionInput): string[] {
  const resource = (i.resourceSkills ?? []).filter((n) => !!n && !NOT_RESOURCE.test(n));
  const tone = resource.filter(isOptionalSkill);
  const types = i.contentTypes ?? detectContentTypes(i.signals ?? {});
  const names = [
    ...tone,
    ...(i.platform && i.platform !== 'telegram' ? [`platform-${i.platform}`] : []),
    formatSkillOf(i.format),
    ...(['deals', 'news'] as const).filter((t) => types.includes(t)).flatMap((t) => TOPIC_SKILLS[t]),
    ...ALWAYS_SKILLS,
    ...resource.filter((n) => !isOptionalSkill(n)),
  ];
  return [...new Set(names.filter((n): n is string => !!n))];
}

// ── compression ────────────────────────────────────────────────────────────

/** Section headings whose whole section is an example (dropped with the section). */
const EXAMPLE_HEADING = /^#{1,6}\s+(приклад|приклади|example|examples)(?!\p{L})/iu;
/** Single example lines: «Добре: …», «Приклад: …», «Наприклад: …» (anti-patterns «Погано: …» stay — they are rules). */
const EXAMPLE_LINE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\*\*)?(добре|приклад|наприклад|example)(?:\*\*)?\s*[:—-]/iu;
/** A table longer than this many lines (header and separator included) is dropped. */
const MAX_TABLE_LINES = 6;

/**
 * A skill body reduced to its rules, deterministic: code fences, example sections and lines, long tables and the
 * H1 title go; headings, bullets and rule paragraphs stay; blank runs collapse.
 */
export function compressSkill(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let fence = false;
  let dropLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^(#{1,6})\s/);
    if (h) {
      const level = h[1].length;
      if (dropLevel && level > dropLevel) continue;
      dropLevel = 0;
      if (EXAMPLE_HEADING.test(line)) { dropLevel = level; continue; }
      if (level === 1) continue;
      out.push(line.trimEnd());
      continue;
    }
    if (dropLevel) continue;
    if (/^\s*\|/.test(line)) {
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      if (j - i <= MAX_TABLE_LINES) out.push(...lines.slice(i, j).map((l) => l.trimEnd()));
      i = j - 1;
      continue;
    }
    if (EXAMPLE_LINE.test(line)) continue;
    out.push(line.trimEnd());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface InlinedSkills {
  /** `### skill: <name>` blocks of the compressed skills that fit, in selection order. */
  blocks:     string[];
  inlined:    string[];
  /** Selected skills that did not fit the budget (named in the prompt). */
  notInlined: string[];
  /** Selected names without a skill body anywhere (dropped silently: a card may list a removed skill). */
  missing:    string[];
  used:       number;
}

/**
 * Compress the selected skills and inline them in order while the budget allows; a skill that does not fit is
 * skipped (a later smaller one may still fit) and named in `notInlined`.
 */
export function inlineCompressedSkills(names: ReadonlyArray<string>, get: (name: string) => Skill | undefined, budget = CRITIC_SKILLS_BUDGET): InlinedSkills {
  const r: InlinedSkills = { blocks: [], inlined: [], notInlined: [], missing: [], used: 0 };
  for (const name of names) {
    const s = get(name);
    if (!s) { r.missing.push(name); continue; }
    const block = `### skill: ${s.name}\n${compressSkill(s.body)}`;
    if (block.length > budget - r.used) { r.notInlined.push(name); continue; }
    r.blocks.push(block);
    r.inlined.push(name);
    r.used += block.length;
  }
  return r;
}

// ── the critic's section ───────────────────────────────────────────────────

/** What selects the critic's skills beyond the post itself (built by the critic gate / the caller). */
export interface CriticSkillsContext {
  /** The resource's skills: the card's `skills` and the agent's attached `tone-*` skills. */
  resource?: ReadonlyArray<string>;
  /** Slot-side content signals (live sources, source hints, the live brief, the series name). */
  signals?:  ContentSignals;
  /** Where skill bodies come from (the agent's view: the owner's overrides); the repo library is the fallback. */
  source?:   SkillSource | null;
}

/** The request fields the critic's skill selection reads (a subset of CriticRequest). */
export interface CriticSkillsRequest {
  platform: string;
  format:   string;
  topic?:   string | null;
  angle?:   string | null;
  spec?:    unknown;
  source?:  { url: string | null } | null;
  skills?:  CriticSkillsContext | null;
}

/**
 * The critic context of an executor slot: the resource skills the writer has inline (the card's `skills`, the agent's
 * inline skills and its attached `tone-*` skills, spec 034 FR-014) and the slot's content signals (live sources,
 * source hints, the live brief, the series name). `skills` is the agent's view (the file library when unrecorded:
 * there a role listing has no tone skill, as none is attached).
 */
export function slotSkillsContext(
  slot: Pick<EditorSlot, 'sourceHints' | 'topicMode' | 'liveSpec' | 'seriesName'>, card: Pick<EditorCard, 'skills'>, skills?: SkillSource | null,
): CriticSkillsContext {
  const tone = (skills?.list('executor') ?? []).map((s) => s.name).filter(isOptionalSkill);
  return {
    resource: [...new Set([...tone, ...(card.skills ?? []), ...(skills?.inlineNames?.() ?? [])])],
    signals: {
      sources: [...(slot.liveSpec?.sources ?? []), ...(slot.sourceHints ?? [])],
      text: [slot.liveSpec?.brief, slot.seriesName],
      live: slot.topicMode === 'live',
    },
    source: skills ?? null,
  };
}

let repoLib: SkillLibrary | null = null;
function repoSkill(name: string): Skill | undefined {
  repoLib ??= new SkillLibrary();
  return repoLib.get(name);
}

/** The skill names the critic of this post gets (the writer's selection for the same slot and post). */
export function criticSkillNames(r: CriticSkillsRequest): string[] {
  const spec = (r.spec && typeof r.spec === 'object' ? r.spec : {}) as { title?: unknown; source?: { url?: unknown } | null };
  const specUrl = typeof spec.source?.url === 'string' ? spec.source.url : null;
  const sig = r.skills?.signals ?? {};
  return selectPostSkills({
    resourceSkills: r.skills?.resource ?? [],
    format: r.format, platform: r.platform,
    signals: {
      sources: sig.sources,
      sourceUrl: sig.sourceUrl ?? specUrl ?? r.source?.url ?? null,
      text: [...(sig.text ?? []), r.topic, r.angle, typeof spec.title === 'string' ? spec.title : null],
      live: sig.live,
    },
  });
}

/** The critic's skills section: compressed rules of the selected skills, and the names that did not fit. */
export function criticSkillsSection(r: CriticSkillsRequest, budget = CRITIC_SKILLS_BUDGET): { lines: string[]; inlined: string[]; notInlined: string[] } {
  const names = criticSkillNames(r);
  const src = r.skills?.source ?? null;
  const got = inlineCompressedSkills(names, (n) => src?.get(n) ?? repoSkill(n), budget);
  if (!got.inlined.length && !got.notInlined.length) return { lines: [], inlined: [], notInlined: [] };
  const lines = [
    '', '## Скіли автора для цього поста (правила без прикладів): оцінюй за ними voice, format_fit, grounding і sense',
    'Порушення правила зі скіла — конкретне зауваження в notes з назвою скіла; явне порушення (вікторина як опитування, строк роздачі минув, змішане звертання) — бал відповідної осі ≤ 2.',
    '', ...got.blocks.flatMap((b, i) => (i ? ['', b] : [b])),
  ];
  if (got.notInlined.length) lines.push('', `Not inlined: ${got.notInlined.join(', ')} (не вмістилися в ліміт; оцінюй за загальними правилами).`);
  return { lines, inlined: got.inlined, notInlined: got.notInlined };
}
