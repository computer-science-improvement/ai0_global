import { entityOverlap, extractEntities, mergeEntities, newEntities, type Entity, type Overlap, type PostEntities } from '../post/entities';
import { addDays, formatLocalStamp, localDay, mentionInstant, parseDateMentions } from '../post/dates';
import { zonedToUtc } from '../roles/time';
import { bodyText, excerptOf, type AuditContext, type AuditPost, type Finding } from '../post/integrity/types';
import { eventVerdict } from './story-event';
import { evergreenKind } from './evergreen-kind';
import { sameTopic, topicKey } from './topic-key';

/**
 * Spec 037 FR-002 (T2): one story, one post. Pure: which earlier posts tell the same story as a post, and what the
 * post may do about it.
 *
 * Two posts tell one story when they share enough entities (post/entities.ts) — a weighted containment of the poorer
 * post (`score`), a minimum of shared weight (one big brand and a date are not a story) — and some topic words. The
 * thresholds are tuned on the golden set (`testing/channel-logs-2026-10.labels.json`, story_pairs): the 9 repeat
 * pairs score 0.43–1.0 with ≥ 3 shared weight and ≥ 0.2 shared stems; unrelated pairs of the same week stay ≤ 0.33,
 * or share a single brand. A digest (`roundup`: three or more sections, each about its own product) is also matched
 * section by section, so a post about one item of yesterday's digest is the same story (Qwen-Image 10.10 → 12.10).
 *
 * What a matching post may be:
 *   • a declared follow-up (`story.followup_of`, kind followup) with `new_facts` that the story's posts do not have
 *     and the post does — at most one follow-up of a story per day; restating more than half of the original is a
 *     warning for the critic (`followup_restates`);
 *   • a declared reminder of a giveaway / deal: one per story, in the last 24 h before its end;
 *   • a digest (kind roundup) may include covered stories;
 *   • evergreen: an evergreen topic does not come back for 30 days.
 * An export (no declared story) is judged by its text: a giveaway / deal post that adds a new title on another day
 * is a follow-up, one that names its own deadline in the last 24 h is the reminder; everything else is a repeat.
 * A sibling channel's post of the same story — or, spec 041, two evergreen posts of one topic key — within 72 h is `story_cross_channel` (the writer decides: skip, own
 * angle or repost).
 */

export const STORY_MATCH = {
  /** Weighted containment of the poorer side. */
  score: 0.4,
  /** Shared entity weight (a multi-word name is 3, a big brand / number / date 1). */
  shared: 3,
  /** Shared topic stems of the smaller side, unless the entity score alone is this high. */
  stems: 0.2,
  strongScore: 0.8,
} as const;

export const STORY_WINDOW_DAYS = 14;
export const EVERGREEN_WINDOW_DAYS = 30;
/** Spec 041 FR-004: a sibling's post of the story within 72 h (was 24: review 2 saw one topic 48 h apart). */
export const CROSS_CHANNEL_HOURS = 72;
/** A sibling's post is reposted only while fresh. */
export const REPOST_HOURS = 24;
export const REMINDER_WINDOW_HOURS = 24;
/** A follow-up that repeats more than this share of the original's entities restates it. */
export const RESTATE_SHARE = 0.5;

const DEAL_RE = /(?<![\p{L}])(?:роздач|роздає|роздаю|розіграш|безкоштовн|безплатн|знижк|розпродаж|акці[яїюйє]|промокод|giveaway|free\b|sale\b)/iu;
/** A reminder names the end: «закривається», «останній день», «встигніть». */
const CLOSING_RE = /(?<![\p{L}])(?:закрива\p{L}*|закінчу\p{L}*|завершу\p{L}*|останн(?:ій|і|я)\s+(?:день|години|годин|шанс)|встигн\p{L}*)/iu;

export interface StoryView {
  post: AuditPost;
  text: string;
  entities: PostEntities;
  /** Paragraph sections (a heading line joins the paragraph after it), only those with entities. */
  sections: PostEntities[];
  /** Three or more sections about different products: a digest. */
  roundup: boolean;
  deal: boolean;
}

const views = new WeakMap<AuditPost, StoryView>();

function sectionsOf(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let pending = '';
  for (const p of paras) {
    const heading = !p.includes('\n') && p.length <= 140 && !/[.!?:…»]$/.test(p);
    if (heading) { pending = pending ? `${pending}\n${p}` : p; continue; }
    out.push(pending ? `${pending}\n${p}` : p);
    pending = '';
  }
  if (pending) out.push(pending);
  return out;
}

const strongNames = (e: PostEntities): string[] => [...e.entities.values()].filter((x) => x.kind === 'name' && x.weight >= 2).map((x) => x.key);

/** The story view of a post (cached per object). */
export function storyView(post: AuditPost): StoryView {
  const hit = views.get(post);
  if (hit) return hit;
  const text = bodyText(post);
  const entities = extractEntities(text);
  const sections = sectionsOf(text).map(extractEntities).filter((s) => [...s.entities.values()].reduce((w, e) => w + e.weight, 0) >= 2);
  const heads = new Set(sections.map((s) => strongNames(s)[0]).filter(Boolean));
  const roundup = sections.filter((s) => strongNames(s).length > 0).length >= 3 && heads.size >= 3;
  const v: StoryView = { post, text, entities, sections, roundup, deal: DEAL_RE.test(text) };
  views.set(post, v);
  return v;
}

/**
 * The thresholds over one overlap.
 *
 * Spec 070 FR-007: the `strongScore` bypass (a near-complete containment with no shared topic words) needs strong evidence
 * (`o.strong`: five shared entities, a strong name, a person, a number or a date), and never applies when either post is
 * evergreen or an explainer (`evergreen`). Review 4: a prompt post naming ChatGPT and Midjourney and the explainer
 * «Нейромережа і ШІ: в чому різниця» naming both as examples scored 1.0 and the explainer was refused as a repeat.
 * Without `evergreen` (the story registry joins posts of other channels, and has no posts) the evidence rule alone applies.
 */
export function isStoryOverlap(o: Overlap, opts: { evergreen?: boolean } = {}): boolean {
  if (o.shared < STORY_MATCH.shared || o.score < STORY_MATCH.score) return false;
  if (o.stems >= STORY_MATCH.stems) return true;
  return o.score >= STORY_MATCH.strongScore && o.strong === true && !opts.evergreen;
}

export interface StoryMatch {
  post: AuditPost;
  overlap: Overlap;
  /** whole post, or one section of a digest on either side. */
  via: 'post' | 'section';
}

/** Whether `a` (the new post) tells the story of `b` (an earlier post): the best overlap that passes, or null. */
export function storyMatch(a: StoryView, b: StoryView): StoryMatch | null {
  const tries: Array<[Overlap, 'post' | 'section']> = [[entityOverlap(a.entities, b.entities), 'post']];
  // A post about one item of a digest is that item's story; two digests sharing an item are not one story.
  if (b.roundup && !a.roundup) for (const s of b.sections) tries.push([entityOverlap(a.entities, s), 'section']);
  if (a.roundup && !b.roundup) for (const s of a.sections) tries.push([entityOverlap(s, b.entities), 'section']);
  // The bypass is off for an explainer / evergreen post on either side: it is judged by its topic words (topicMatch).
  // Only asked when some overlap has no shared topic words, so the common case costs nothing.
  const evergreen = tries.some(([o]) => o.stems < STORY_MATCH.stems)
    && (isEvergreenPost(a.post) || isEvergreenPost(b.post) || a.post.story?.kind === 'evergreen' || b.post.story?.kind === 'evergreen');
  const ok = tries.filter(([o]) => isStoryOverlap(o, { evergreen })).sort(([x], [y]) => y.score - x.score || y.shared - x.shared);
  return ok.length ? { post: b.post, overlap: ok[0][0], via: ok[0][1] } : null;
}

const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
const hasText = (p: AuditPost) => bodyText(p).trim().length > 0;
const leadOf = (p: AuditPost) => p.lead ?? bodyText(p).split('\n')[0] ?? '';

/** Spec 041 FR-004: the topic key of a post (title, lead and the first sentence after it), cached like the story view. */
const topics = new WeakMap<AuditPost, string[]>();
export function topicOf(p: AuditPost): string[] {
  let k = topics.get(p);
  if (!k) {
    const lead = leadOf(p);
    const rest = bodyText(p).slice(bodyText(p).indexOf(lead) + lead.length).trim();
    const first = /^[^.!?…\n]{0,240}[.!?…]?/u.exec(rest)?.[0] ?? '';
    k = topicKey({ title: p.title, lead: `${lead}\n${first}` });
    topics.set(p, k);
  }
  return k;
}

/**
 * Spec 041 FR-004: is the post evergreen by code (an explainer, how-to, glossary or listicle)? A post built from a
 * spec without any external source counts too; an export only by its title / lead (its source line may be missing).
 */
export function isEvergreenPost(p: AuditPost): boolean {
  const sourced = !!p.sourceUrl || !!p.citedSourceUrl || p.links.length > 0 || p.buttons.some((b) => !!b.url);
  return evergreenKind({ title: p.title, lead: leadOf(p), hasSource: p.story === undefined || sourced, declared: p.story?.kind }) !== null;
}

/**
 * A topic-only match of two evergreen posts: the shared stems as the overlap (a sibling or an evergreen repeat with no
 * shared entities). A news post is matched by its entities only — a glossary line «Агент: … виконує завдання» is not
 * the story of «Gemini став агентом, що виконує завдання».
 */
function topicMatch(a: AuditPost, b: AuditPost): StoryMatch | null {
  if (!isEvergreenPost(a) || !isEvergreenPost(b)) return null;
  const ka = topicOf(a);
  const shared = sameTopic(ka, topicOf(b));
  if (!shared) return null;
  const share = shared.length / Math.min(ka.length, topicOf(b).length);
  return { post: b, overlap: { score: share, shared: shared.length, keys: shared.map((s) => `topic:${s}`), stems: share, strong: false }, via: 'post' };
}

/** The end of a giveaway / deal: the latest «до <дата> [час]» of the posts (a day without a time ends at midnight). */
export function storyDeadline(posts: AuditPost[]): Date | null {
  let best: Date | null = null;
  for (const p of posts) {
    const tz = p.timezone || 'Europe/Kyiv';
    const ms = parseDateMentions(bodyText(p), { publishedAt: p.publishedAt, timezone: tz });
    for (const m of ms) {
      if (m.preposition !== 'until' || !m.date || m.historical || m.kind === 'weekday') continue;
      const at = mentionInstant(m) ?? zonedToUtc(addDays(m.date, 1), '00:00', tz);
      if (!best || at.getTime() > best.getTime()) best = at;
    }
  }
  return best;
}

/** The post names its own end («до 15:00», «сьогодні закривається»). */
function namesDeadline(p: AuditPost): boolean {
  const text = bodyText(p);
  if (CLOSING_RE.test(text)) return true;
  return parseDateMentions(text, { publishedAt: p.publishedAt, timezone: p.timezone || 'Europe/Kyiv' }).some((m) => m.preposition === 'until');
}

/** The keys of a fact's entities and numbers; a fact without any is compared by its words. */
function factEntities(fact: string): Entity[] {
  return [...extractEntities(fact).entities.values()].filter((e) => e.weight > 0);
}

export interface StoryAssessment {
  findings: Finding[];
  /** Earlier posts of the resource that tell the same story (newest first). */
  matches: StoryMatch[];
  /** Sibling channels' posts of the same story (or topic) in the last 72 h. */
  siblings: StoryMatch[];
  /** The original of the story (the oldest match, or the declared `followup_of`). */
  original: AuditPost | null;
  /** How the post relates to its matches. */
  role: 'original' | 'followup' | 'reminder' | 'roundup' | 'evergreen' | 'repeat';
}

function describe(p: AuditPost): string {
  const lead = p.lead ?? bodyText(p).split('\n')[0] ?? '';
  return `${formatLocalStamp(p.publishedAt, p.timezone || 'Europe/Kyiv')} «${excerptOf(lead, 90)}»`;
}

/**
 * Spec 037 T2: the story assessment of a post against the earlier posts of its resource (`ctx.previous`, 14 days;
 * 30 for evergreen) and its network group (`ctx.network`, 72 h). Without `ctx.previous` (lintPost before publishing)
 * there is nothing to compare with and nothing is found; the publish guard passes the history.
 */
export function assessStory(post: AuditPost, ctx: AuditContext): StoryAssessment {
  const none: StoryAssessment = { findings: [], matches: [], siblings: [], original: null, role: 'original' };
  if (!hasText(post)) return none; // a poll message is the companion of its text post
  const me = storyView(post);
  const declared = post.story;
  const evergreen = declared?.kind === 'evergreen';
  const windowH = (evergreen ? EVERGREEN_WINDOW_DAYS : STORY_WINDOW_DAYS) * 24;

  const matches: StoryMatch[] = [];
  for (const p of ctx.previous ?? []) {
    const h = hoursBetween(p.publishedAt, post.publishedAt);
    if (Math.abs(h) > windowH || p.id === post.id || !hasText(p)) continue;
    // An evergreen topic is compared with every post of 30 days; any other post with 14 days of posts. A post
    // scheduled later (approved, waiting) counts too: the slot that goes out second is the repeat.
    const m = storyMatch(me, storyView(p));
    if (m) matches.push(m);
  }
  const siblings: StoryMatch[] = [];
  for (const p of ctx.network ?? []) {
    const h = hoursBetween(p.publishedAt, post.publishedAt);
    if (Math.abs(h) > CROSS_CHANNEL_HOURS || !hasText(p)) continue;
    // Spec 041 FR-004: by the story's entities or by the topic key (an explainer on the same topic).
    const m = storyMatch(me, storyView(p)) ?? topicMatch(post, p);
    if (m) siblings.push(m);
  }
  matches.sort((a, b) => Date.parse(b.post.publishedAt) - Date.parse(a.post.publishedAt));

  const findings: Finding[] = [];
  if (siblings.length) {
    const s = siblings[0].post;
    findings.push({
      code: 'story_cross_channel', level: 'warning', excerpt: excerptOf(s.lead ?? bodyText(s), 90),
      message: `${s.channel} уже опублікував цю історію ${describe(s)}: пропусти, дай власний кут (story.decision own_angle) або зроби репост (request_story_repost)`,
    });
  }
  if (!matches.length) {
    // Spec 041 FR-004: an evergreen post (by code) on a topic the resource covered in 30 days.
    const again = declared?.kind !== 'roundup' && declared?.kind !== 'followup' && !declared?.followupOf && isEvergreenPost(post)
      ? topicRepeatOf(post, ctx.previous ?? []) : null;
    if (again) {
      return {
        findings: [...findings, {
          code: 'topic_repeat', level: 'error', excerpt: excerptOf(leadOf(again.post), 90),
          message: `ця тема вже була за останні ${EVERGREEN_WINDOW_DAYS} днів: ${describe(again.post)} (спільне: ${again.overlap.keys.slice(0, 5).map((k) => k.slice(6)).join(', ')}). Візьми іншу тему або інший аспект з іншими ключовими словами`,
        }],
        matches: [again], siblings, original: again.post, role: 'repeat',
      };
    }
    return { ...none, findings, siblings, role: declared?.kind === 'evergreen' ? 'evergreen' : declared?.kind === 'roundup' ? 'roundup' : 'original' };
  }

  const byId = new Map(matches.map((m) => [m.post.id, m.post]));
  const original = (declared?.followupOf && (byId.get(declared.followupOf) ?? (ctx.previous ?? []).find((p) => p.id === declared.followupOf)))
    || matches[matches.length - 1].post;
  const story = matches.map((m) => m.post);
  const storyEntities = mergeEntities(story.map((p) => storyView(p).entities));
  const tz = post.timezone || 'Europe/Kyiv';
  const today = localDay(post.publishedAt, tz);
  const list = story.slice(0, 3).map(describe).join('; ');
  const repeat = (why: string): StoryAssessment => ({
    findings: [...findings, {
      code: 'story_repeat', level: 'error', excerpt: excerptOf(original.lead ?? bodyText(original), 90),
      message: `${why}: ${list}. Візьми інший матеріал або напиши продовження з новими фактами (story.followup_of + new_facts)`,
    }],
    matches, siblings, original, role: 'repeat',
  });

  // A digest may include covered stories.
  if (declared?.kind === 'roundup') return { findings, matches, siblings, original, role: 'roundup' };

  const kind = declared ? declared.kind ?? (declared.followupOf ? 'followup' : undefined) : undefined;

  // Spec 037 T3: a story with an announced event — one announcement, one reminder in the last 24 h, then the recap.
  if (!evergreen) {
    const addsFacts = newEntities(me.entities, storyEntities).reduce((w, e) => w + e.weight, 0) >= 2;
    const ev = eventVerdict({ post, story, kind, deal: me.deal, addsFacts });
    if (ev && 'repeat' in ev) return repeat(ev.repeat);
    if (ev) return { findings, matches, siblings, original, role: ev.role };
  }

  if (kind === 'reminder' || (!declared && me.deal && namesDeadline(post))) {
    const end = storyDeadline([...story, post]);
    const left = end ? (end.getTime() - Date.parse(post.publishedAt)) / 3_600_000 : null;
    const earlier = story.find((p) => p.story?.kind === 'reminder' || (!p.story && reminderLike(p, story, end)));
    if (left !== null && left > 0 && left <= REMINDER_WINDOW_HOURS && !earlier) return { findings, matches, siblings, original, role: 'reminder' };
    if (kind === 'reminder') {
      return repeat(earlier
        ? `нагадування про цю історію вже було (${describe(earlier)}) — одне на роздачу`
        : left === null ? 'нагадування — лише в останні 24 год до кінця роздачі чи знижки, а дати кінця («до …») не видно ні в пості, ні в історії'
          : `нагадування — лише в останні ${REMINDER_WINDOW_HOURS} год до кінця (до кінця ${Math.round(left)} год)`);
    }
  }

  if (kind === 'followup') {
    const sameDay = story.find((p) => p.story?.kind === 'followup' && localDay(p.publishedAt, tz) === today);
    if (sameDay) return repeat(`продовження цієї історії сьогодні вже було (${describe(sameDay)}) — не більше одного на день`);
    const facts = declared?.newFacts ?? [];
    const stale: string[] = [];
    for (const f of facts) {
      const es = factEntities(f);
      const fresh = es.filter((e) => !storyEntities.entities.has(e.key));
      const inPost = fresh.some((e) => me.entities.entities.has(e.key));
      if (!fresh.length || !inPost) stale.push(f);
    }
    if (!facts.length || stale.length) {
      return {
        findings: [...findings, {
          code: 'followup_without_new_facts', level: 'error', excerpt: excerptOf(stale[0] ?? original.lead ?? bodyText(original), 90),
          message: facts.length
            ? `ці «нові факти» вже були в історії або їх немає в пості: ${stale.map((s) => `«${excerptOf(s, 60)}»`).join(', ')} — продовження лише з новою назвою чи числом, яких не було в ${describe(original)}`
            : `продовження без new_facts: назви, що нового (число, назва, дата), чого не було в ${describe(original)}`,
        }],
        matches, siblings, original, role: 'repeat',
      };
    }
    const orig = storyView(original).entities;
    const ow = [...orig.entities.values()].reduce((w, e) => w + e.weight, 0);
    const kept = [...orig.entities.values()].filter((e) => me.entities.entities.has(e.key)).reduce((w, e) => w + e.weight, 0);
    if (ow > 0 && kept / ow > RESTATE_SHARE) {
      findings.push({
        code: 'followup_restates', level: 'warning', excerpt: excerptOf(original.lead ?? bodyText(original), 90),
        message: `продовження повторює ${Math.round((kept / ow) * 100)}% назв і чисел оригіналу (${describe(original)}) — читач його бачив, лиши нове й коротке нагадування`,
      });
    }
    return { findings, matches, siblings, original, role: 'followup' };
  }

  // An export: a giveaway that adds a new title on another day is a follow-up (Out of Sight + TerraScape, 10.10).
  if (!declared && me.deal) {
    const added = newEntities(me.entities, storyEntities).filter((e) => e.kind === 'name' && e.weight >= 2);
    const sameDay = story.some((p) => localDay(p.publishedAt, tz) === today);
    if (added.length && !sameDay) return { findings, matches, siblings, original, role: 'followup' };
  }

  if (evergreen) return repeat(`ця вічнозелена тема вже була за останні ${EVERGREEN_WINDOW_DAYS} днів`);
  return repeat(`та сама історія вже була на цьому ресурсі за ${STORY_WINDOW_DAYS} днів`);
}

/** An earlier export post of the story that was itself the reminder (names the end, in the last 24 h). */
function reminderLike(p: AuditPost, story: AuditPost[], end: Date | null): boolean {
  if (!end || p === story[story.length - 1] || !storyView(p).deal || !namesDeadline(p)) return false;
  const left = (end.getTime() - Date.parse(p.publishedAt)) / 3_600_000;
  return left > 0 && left <= REMINDER_WINDOW_HOURS;
}

/** Spec 041 FR-004: the newest post of 30 days on the same topic as an evergreen post (null when none). */
export function topicRepeatOf(post: AuditPost, previous: readonly AuditPost[]): StoryMatch | null {
  let best: StoryMatch | null = null;
  for (const p of previous) {
    const h = hoursBetween(p.publishedAt, post.publishedAt);
    if (Math.abs(h) > EVERGREEN_WINDOW_DAYS * 24 || p.id === post.id || !hasText(p)) continue;
    const m = topicMatch(post, p);
    if (m && (!best || Date.parse(p.publishedAt) > Date.parse(best.post.publishedAt))) best = m;
  }
  return best;
}
