import type { Pool } from 'pg';
import { PostSpecSchema } from '../post/post-spec';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import { bodyText } from '../post/integrity/types';
import { jargonOverLevel, type AudienceLevel } from '../post/variety/jargon';
import { resourceStyleOf } from '../post/style/style-store';

/**
 * Spec 037 FR-009 (T9): feed fit in the MANAGER's quality digest. Per feed a resource wrote from in the window: how
 * many items, how many of them carry unexplained jargon over the resource's audience level (`jargon_over_level`,
 * recomputed from the stored post), got a critic `revise` (final or the first pass) or `reject`. A feed with enough
 * items where most go wrong gets a suggestion: `limit` (use it less, pick and explain) or `replace` (find another
 * feed) — e.g. MarkTechPost for AI Технології, a research feed retold to «ordinary people».
 *
 * The feed of a slot: the post's `source.url` host, else the live slot's item / first feed, else the first source
 * hint. A slot the critic rejected keeps no post spec, so it is attributed by its live spec or hints only (a fixed
 * slot without hints is not attributed). Nothing new is stored: everything comes from `editor_slots`.
 */

/** Fewer items than this from a feed: no suggestion (too few to judge). */
export const FEED_MIN_ITEMS = 3;
/** Share of misfit items (jargon over the level, revise or reject) from which a feed is to be limited / replaced. */
export const FEED_LIMIT_SHARE = 0.5;
export const FEED_REPLACE_SHARE = 0.75;
/** Feeds listed per resource (worst first). */
export const MAX_FEEDS = 5;

export interface FeedItem { feed: string | null; jargon: boolean; revise: boolean; reject: boolean }

export interface FeedFit {
  /** Host of the feed (www. dropped) or the card source id. */
  feed:              string;
  items:             number;
  jargon_over_level: number;
  revise:            number;
  reject:            number;
  /** Items with any of the three / items. */
  misfit_share:      number;
  /** `replace` from FEED_REPLACE_SHARE, `limit` from FEED_LIMIT_SHARE (with ≥ FEED_MIN_ITEMS items), else null. */
  suggestion:        'replace' | 'limit' | null;
}

/** `https://www.marktechpost.com/2026/…` → `marktechpost.com`; a non-URL source id stays as it is. */
export function feedKey(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  if (!/^https?:/i.test(ref.trim())) return ref.trim().slice(0, 80);
  try {
    return new URL(ref.trim()).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The feed a slot's post came from (see the module comment). */
export function feedOfSlot(r: { post_spec?: any; live_spec?: any; source_hints?: unknown }): string | null {
  const hints = Array.isArray(r.source_hints) ? r.source_hints : [];
  const live = r.live_spec && typeof r.live_spec === 'object' ? r.live_spec : null;
  const sources = Array.isArray(live?.sources) ? live.sources : [];
  return feedKey(r.post_spec?.source?.url) ?? feedKey(live?.item?.url) ?? feedKey(sources[0]) ?? feedKey(hints.find((h: unknown) => typeof h === 'string' && /^https?:/i.test(h)));
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

/** Per-feed fit of one resource's items (pure), worst first, at most MAX_FEEDS. */
export function assembleFeeds(items: readonly FeedItem[]): FeedFit[] {
  const by = new Map<string, FeedFit & { bad: number }>();
  for (const i of items) {
    if (!i.feed) continue;
    const f = by.get(i.feed) ?? { feed: i.feed, items: 0, jargon_over_level: 0, revise: 0, reject: 0, misfit_share: 0, suggestion: null, bad: 0 };
    f.items++;
    if (i.jargon) f.jargon_over_level++;
    if (i.revise) f.revise++;
    if (i.reject) f.reject++;
    if (i.jargon || i.revise || i.reject) f.bad++;
    by.set(i.feed, f);
  }
  return [...by.values()]
    .map(({ bad, ...f }) => {
      const share = ratio(bad, f.items);
      const suggestion = f.items < FEED_MIN_ITEMS ? null : share >= FEED_REPLACE_SHARE ? 'replace' as const : share >= FEED_LIMIT_SHARE ? 'limit' as const : null;
      return { ...f, misfit_share: share, suggestion };
    })
    .sort((a, b) => b.misfit_share - a.misfit_share || b.items - a.items || a.feed.localeCompare(b.feed))
    .slice(0, MAX_FEEDS);
}

/** One slot row → a feed item: the critic's verdicts (final and history) and the jargon of the stored post. */
export function feedItemOf(r: { post_spec?: any; live_spec?: any; source_hints?: unknown; critic?: any }, level: AudienceLevel | null | undefined): FeedItem {
  const c = r.critic && typeof r.critic === 'object' ? r.critic : null;
  const verdicts = [c?.verdict, ...(Array.isArray(c?.history) ? c.history.map((h: any) => h?.verdict) : [])];
  let jargon = false;
  const spec = r.post_spec ? PostSpecSchema.safeParse(r.post_spec) : null;
  if (level && spec?.success) {
    const post = auditPostFromSpec(spec.data, { id: 'feed-fit', channel: '', publishedAt: new Date(0).toISOString(), timezone: 'UTC' });
    jargon = !!jargonOverLevel([bodyText(post), post.poll?.question ?? '', ...(post.poll?.options ?? [])].join('\n'), level);
  }
  return { feed: feedOfSlot(r), jargon, revise: verdicts.includes('revise'), reject: c?.verdict === 'reject' };
}

const REF = `COALESCE(s.resource_ref, 'telegram:' || s.channel_key)`;

/** The feed-fit block of each resource for slots scheduled in [from, to). */
export class SqlFeedFit {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async feeds(refs: string[], from: Date, to: Date): Promise<Map<string, FeedFit[]>> {
    const out = new Map<string, FeedFit[]>();
    if (!refs.length) return out;
    const { rows } = await this.pool.query(
      `SELECT ${REF} AS ref, s.post_spec, s.live_spec, s.source_hints, s.critic
         FROM editor_slots s
        WHERE s.kind = 'content' AND ${REF} = ANY($1::text[]) AND s.scheduled_at >= $2 AND s.scheduled_at < $3
          AND (s.critic IS NOT NULL OR s.status IN ('published','shadowed','awaiting_approval','approved'))
        ORDER BY s.scheduled_at DESC LIMIT 3000`, [refs, from, to]);
    const levels = new Map<string, AudienceLevel | null>();
    for (const ref of refs) {
      levels.set(ref, (await resourceStyleOf(this.pool, ref).catch(() => null))?.effective.audience?.level ?? null);
    }
    const items = new Map<string, FeedItem[]>();
    for (const r of rows) {
      const list = items.get(r.ref) ?? [];
      list.push(feedItemOf(r, levels.get(r.ref)));
      items.set(r.ref, list);
    }
    for (const [ref, list] of items) {
      const feeds = assembleFeeds(list);
      if (feeds.length) out.set(ref, feeds);
    }
    return out;
  }
}
