import { entityOverlap, extractEntities, type PostEntities } from '../post/entities';
import { formatLocalStamp } from '../post/dates';
import { excerptOf } from '../post/integrity/types';

/**
 * Spec 037 FR-002 (T2): what the agents see of the story registry, pure. The planner and the writer get the
 * "Active stories (14 days)" block (the network group's stories too: a sibling's story of the last 24 h needs a
 * decision), `fetch_feed` marks the items an active story already covers, and the critic gets the story's earlier
 * posts with their dates and key facts.
 */

export interface ActiveStory {
  key:         string;
  title:       string;
  kind:        'news' | 'evergreen';
  firstPostAt: string;
  lastPostAt:  string;
  /** Posts of the story on this resource. */
  posts:       number;
  /** The original on this resource (a `followup_of` id), when the resource has posted the story. */
  originalRef: string | null;
  keyFacts:    string[];
  eventAt:     string | null;
  /** Sibling channels of the network group that posted the story, with their newest post (a repost source). */
  siblings:    Array<{ channelKey: string; at: string; postRef: string | null }>;
  /** Shown entities (names first), for matching feed items. */
  entities?:   PostEntities;
}

export const ACTIVE_STORIES_MAX = 15;
const SIBLING_DECISION_HOURS = 24;

/** The "Active stories (14 days)" block of the planner and writer prompts; null when there is none. */
export function activeStoriesBlock(all: ActiveStory[], o: { timezone: string; now: Date; role: 'planner' | 'executor' }): string | null {
  // A sibling's story matters for 24 h (the decision); the resource's own stories for their whole window.
  const recent = (x: { at: string }) => o.now.getTime() - Date.parse(x.at) <= SIBLING_DECISION_HOURS * 3_600_000;
  const stories = all.filter((s) => s.posts > 0 || s.siblings.some(recent));
  if (!stories.length) return null;
  const at = (iso: string) => formatLocalStamp(iso, o.timezone).replace(/^[^,]+,\s*/, '').replace(/\s*\([^)]*\)$/, '');
  const lines = stories.slice(0, ACTIVE_STORIES_MAX).map((s) => {
    const parts = [`- ${s.key}: «${excerptOf(s.title, 90)}»`];
    if (s.posts) parts.push(`${s.posts} пост(и) тут, останній ${at(s.lastPostAt)}${s.originalRef ? `, оригінал ${s.originalRef}` : ''}`);
    const fresh = s.siblings.filter(recent);
    if (s.siblings.length) {
      parts.push(`сусідні канали: ${s.siblings.map((x) => `${x.channelKey} ${at(x.at)}${x.postRef ? ` (${x.postRef})` : ''}`).join(', ')}`);
    }
    if (!s.posts && fresh.length) parts.push('вийшла в сусіда за 24 год → skip / own_angle / request_story_repost');
    if (s.keyFacts.length) parts.push(`факти: ${s.keyFacts.slice(0, 4).map((f) => excerptOf(f, 60)).join('; ')}`);
    if (s.eventAt) parts.push(`подія: ${at(s.eventAt)}`);
    if (s.kind === 'evergreen') parts.push('evergreen — не повторювати 30 днів');
    return parts.join(' · ');
  });
  const rule = o.role === 'planner'
    ? 'Не плануй ці історії знову; повернутися можна лише з новим фактом (продовження) або одним нагадуванням роздачі в останні 24 год.'
    : 'Ця історія вже вийшла? Тоді інший матеріал, або продовження з новим фактом: story { followup_of: <id оригіналу>, kind: "followup", new_facts: [...] } (піде відповіддю на оригінал, ≤ 1 на день), або одне нагадування роздачі в останні 24 год (kind: "reminder"). Історія сусіднього каналу за 24 год: skip_slot, власний кут (story.decision: "own_angle" + reason) або request_story_repost.';
  return ['## Активні історії (14 днів)', rule, ...lines].join('\n');
}

/** Spec 037 T2: a feed item already covered by an active story (its key), else null. Item text is short: names decide. */
export function coveringStory(item: { title?: string | null; snippet?: string | null }, stories: Array<Pick<ActiveStory, 'key' | 'entities'>>): string | null {
  const e = extractEntities(namesOnly([item.title, item.snippet].filter(Boolean).join('\n')));
  const own = [...e.entities.values()].reduce((w, x) => w + x.weight, 0);
  if (!own) return null;
  let best: { key: string; score: number } | null = null;
  for (const s of stories) {
    if (!s.entities) continue;
    const o = entityOverlap(e, s.entities);
    const strong = o.keys.some((k) => (e.entities.get(k)?.weight ?? 0) >= 2);
    const itemSide = o.shared / own;
    if (strong && o.shared >= 2 && itemSide >= 0.5 && (!best || itemSide > best.score)) best = { key: s.key, score: itemSide };
  }
  return best?.key ?? null;
}

const EN_KEEP = new Set(['trillion', 'billion', 'million', 'thousand', 'of', 'the']);

/**
 * An English feed item: the entity extractor reads a run of Latin words as one name (it is built for Ukrainian posts,
 * where Latin words are names), so lowercase English words other than units and name connectors are cut out.
 */
export function namesOnly(text: string): string {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cyr = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  if (latin <= cyr) return text;
  return text.replace(/(?<![A-Za-z0-9])[a-z][a-z'’]*(?![A-Za-z0-9])/g, (w) => (EN_KEEP.has(w) ? w : '·'));
}

/** What the critic gets of a story: the earlier posts (date, channel, lead, key facts) and the first post's date. */
export interface CriticStoryContext {
  /** The post's role in its story (original / followup / reminder / roundup / evergreen). */
  role:        string;
  firstPostAt: string | null;
  posts:       Array<{ at: string; channel: string; lead: string; facts: string[]; sibling?: boolean }>;
  /** The writer's declared new facts / decision. */
  newFacts?:   string[];
  decision?:   string | null;
}

export const CRITIC_STORY_POSTS = 4;

/** The critic prompt lines of a story; empty without earlier posts. */
export function criticStoryLines(c: CriticStoryContext | null | undefined, timezone: string): string[] {
  if (!c || !c.posts.length) return [];
  const out = ['', '## Історія цього поста (попередні пости)',
    `Роль поста: ${c.role}. Пост не має повторювати сказане — лише нове; суперечність з фактами попередніх постів → grounding ≤ 2.`];
  for (const p of c.posts.slice(0, CRITIC_STORY_POSTS)) {
    out.push(`- ${formatLocalStamp(p.at, timezone)}${p.sibling ? ` (сусідній канал ${p.channel})` : ''}: «${excerptOf(p.lead, 120)}»${p.facts.length ? ` — ${p.facts.slice(0, 6).join(', ')}` : ''}`);
  }
  if (c.newFacts?.length) out.push(`Нові факти за словами автора: ${c.newFacts.map((f) => `«${excerptOf(f, 80)}»`).join(', ')}.`);
  if (c.decision) out.push(`Рішення щодо історії сусіднього каналу: ${c.decision}.`);
  return out;
}
