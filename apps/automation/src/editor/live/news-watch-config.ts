import { z } from 'zod';
import type { CardSource, EditorCard } from '../card';

/**
 * Spec 034 FR-011: the news watch of a news resource — a code-only feed check on a cadence that adds a
 * live slot for a fresh, unposted, on-topic item when the day has room. Owner-editable in the resource
 * profile (`news_watch`); every field is optional and falls back to the defaults below.
 */
export const NewsWatchSchema = z.object({
  /** Absent = on for a news resource (a card with RSS feeds whose brief / topic says news); false = off; true = on. */
  enabled:       z.boolean().optional(),
  every_hours:   z.number().int().min(1).max(12).optional(),
  from_hour:     z.number().int().min(0).max(23).optional(),
  to_hour:       z.number().int().min(1).max(24).optional(),
  max_per_day:   z.number().int().min(0).max(6).optional(),
  max_age_hours: z.number().int().min(1).max(24).optional(),
}).strict().refine((w) => w.from_hour === undefined || w.to_hour === undefined || w.from_hour < w.to_hour, { message: 'from_hour < to_hour' });
export type NewsWatch = z.infer<typeof NewsWatchSchema>;

export const NEWS_WATCH_DEFAULTS = { every_hours: 2, from_hour: 8, to_hour: 22, max_per_day: 3, max_age_hours: 3 } as const;

export interface ResolvedNewsWatch {
  everyHours:  number;
  fromHour:    number;
  toHour:      number;
  maxPerDay:   number;
  maxAgeHours: number;
  feeds:       Array<{ id: string; url: string }>;
  keywords:    string[];
}

const NEWS_RE = /новин|news|breaking|дайджест/i;

/** Is the card a news resource (spec 034: its news slots are live by default, the news watch is on)? */
export function isNewsCard(card: Pick<EditorCard, 'brief' | 'title' | 'formats' | 'sources'>, topic?: string | null): boolean {
  const rss = card.sources.some((s) => s.kind === 'rss');
  return rss && (Number(card.formats.news ?? 0) > 0 || NEWS_RE.test(`${card.title ?? ''} ${card.brief} ${topic ?? ''}`));
}

function cardFeeds(sources: CardSource[]): Array<{ id: string; url: string }> {
  return sources.filter((s) => s.kind === 'rss' && /^https?:\/\//i.test(s.ref)).map((s) => ({ id: s.id, url: s.ref }));
}

/** Generic words of briefs that say nothing about the topic (5-letter stems). */
const STOP_STEMS = new Set([
  'новин', 'канал', 'пості', 'посту', 'читач', 'аудит', 'конте', 'щодня', 'корот', 'свіжі', 'найці', 'цікав', 'тільк', 'також',
  'telegram', 'news', 'daily', 'post', 'posts', 'chann', 'about', 'fresh', 'короткі', 'україн', 'украї',
].map((w) => w.slice(0, 5)));

const tokens = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Topic keywords (5-letter stems, ≥ 4-letter words) of the resource's topic, brief and title. */
export function topicKeywords(texts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const w of tokens(texts.filter(Boolean).join(' '))) {
    if (w.length < 4 || /^\d+$/.test(w)) continue;
    const stem = w.slice(0, 5);
    if (!STOP_STEMS.has(stem) && !out.includes(stem)) out.push(stem);
  }
  return out.slice(0, 40);
}

/** How many of the keywords a text mentions (a word starting with the stem). */
export function keywordHits(text: string, stems: string[]): number {
  if (!stems.length) return 0;
  const words = tokens(text);
  return stems.filter((s) => words.some((w) => w.startsWith(s))).length;
}

/** The effective news watch of a card (null = off: not a news resource, disabled, or no feeds). */
export function newsWatchConfig(
  card: Pick<EditorCard, 'brief' | 'title' | 'formats' | 'sources'>,
  profile: { topic?: string | null; news_watch?: NewsWatch | null } | null,
): ResolvedNewsWatch | null {
  const nw = profile?.news_watch ?? {};
  if (nw.enabled === false) return null;
  const feeds = cardFeeds(card.sources);
  if (!feeds.length) return null;
  if (nw.enabled !== true && !isNewsCard(card, profile?.topic)) return null;
  return {
    everyHours: nw.every_hours ?? NEWS_WATCH_DEFAULTS.every_hours,
    fromHour: nw.from_hour ?? NEWS_WATCH_DEFAULTS.from_hour,
    toHour: nw.to_hour ?? NEWS_WATCH_DEFAULTS.to_hour,
    maxPerDay: nw.max_per_day ?? NEWS_WATCH_DEFAULTS.max_per_day,
    maxAgeHours: nw.max_age_hours ?? NEWS_WATCH_DEFAULTS.max_age_hours,
    feeds,
    keywords: topicKeywords([profile?.topic, card.brief, card.title]),
  };
}

/** The score of a fresh item (0–1): freshness and topic fit, half each. */
export function itemScore(ageHours: number, maxAgeHours: number, hits: number, keywords: number): number {
  const fresh = Math.max(0, 1 - ageHours / Math.max(maxAgeHours, 0.1));
  const topical = keywords ? Math.min(hits, 3) / 3 : 0.5;
  return Math.round((fresh * 0.5 + topical * 0.5) * 1000) / 1000;
}

/** Below this an on-topic fresh item is not worth a slot of its own. */
export const NEWS_WATCH_MIN_SCORE = 0.4;
