import type { Pool } from 'pg';
import Parser from 'rss-parser';
import type { CardSource } from '../card';
import { safeGet, type RawGet } from '../net/safe-http';
import type { Lookup } from '../net/ssrf-guard';
import { ledgerResource } from '../../data/content-ledger';
import { containment, similarity } from '../post/similarity';
import type { LiveCandidate, LiveScan, LiveSpec } from './live-slot';

/**
 * Feed items for live slots and the news watch (spec 034 FR-010/FR-011): read a feed, compute each
 * item's age, and drop what is too old, already used on the resource (content ledger, waiting posts,
 * items other live slots took) or a near-duplicate of the resource's last 7 days. Code only, no LLM.
 */

export interface FeedItem {
  title:     string | null;
  link:      string | null;
  date:      string | null;
  snippet:   string;
  image:     string | null;
  /** Hours since the item's date (0 for a date in the future); null when the feed gives no date. */
  age_hours: number | null;
}

export interface HttpSeams { lookup?: Lookup; get?: RawGet }

/** A news title against a recent post: containment of the title in the post's head, or Dice. ≥ this → a repeat. */
export const LIVE_SIMILAR = 0.6;

const FEED_ACCEPT = 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const parser = new Parser({ timeout: 10_000 });

export function ageHours(date: string | null | undefined, now: Date): number | null {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10);
}

/** Read one RSS/Atom feed through the SSRF-safe GET. Throws on an HTTP error or unparsable XML. */
export async function readFeed(url: string, now: Date, http: HttpSeams = {}): Promise<{ title: string | null; items: FeedItem[] }> {
  const res = await safeGet(url, { lookup: http.lookup, get: http.get, accept: FEED_ACCEPT });
  if (res.status >= 400) throw new Error(`status ${res.status}`);
  const feed = await parser.parseString(res.body);
  return {
    title: feed.title ?? null,
    items: (feed.items ?? []).map((it: any) => {
      const date = it.isoDate ?? it.pubDate ?? null;
      return {
        title:     it.title ?? null,
        link:      it.link ?? null,
        date,
        snippet:   clip(String(it.contentSnippet ?? it.summary ?? '').replace(/\s+/g, ' ').trim(), 400),
        image:     it.enclosure?.url ?? null,
        age_hours: ageHours(date, now),
      };
    }),
  };
}

/** How close a title is to the closest recent text (0–1). */
export function closestRecent(title: string, corpus: string[]): number {
  let best = 0;
  for (const text of corpus) {
    if (!text) continue;
    best = Math.max(best, containment(title, text.slice(0, 600)), similarity(title, text.slice(0, 300)));
    if (best >= 0.999) break;
  }
  return best;
}

/** Item URLs that may not go out on the resource: ledger, waiting / running posts, live slots holding the item. */
export async function usedUrls(pool: Pick<Pool, 'query'>, resourceRef: string, urls: string[], excludeSlotId: string | null = null): Promise<Set<string>> {
  if (!urls.length) return new Set();
  const rr = ledgerResource(resourceRef);
  const { rows } = await pool.query(
    `SELECT u FROM unnest($2::text[]) AS u
      WHERE EXISTS (SELECT 1 FROM content_ledger_blocking($1, content_ref_aliases(u), 'resource', now()))
         OR EXISTS (SELECT 1 FROM editor_slots s
                     WHERE COALESCE(s.resource_ref, 'telegram:' || s.channel_key) = $1
                       AND ($3::uuid IS NULL OR s.id <> $3)
                       AND ((s.status IN ('running','awaiting_approval','approved')
                             AND (s.post_spec->'source'->>'url' = ANY(content_ref_aliases(u)) OR s.platform_spec->'source'->>'url' = ANY(content_ref_aliases(u))))
                         OR (s.status IN ('planned','running') AND s.topic_mode = 'live' AND s.live_spec->'item'->>'url' = u)))`,
    [rr, urls, excludeSlotId && /^[0-9a-f-]{36}$/i.test(excludeSlotId) ? excludeSlotId : null]);
  return new Set(rows.map((r: any) => String(r.u)));
}

/**
 * What the resource said or is about to say: its posts of the last 7 days (published, shadowed, waiting,
 * running), the topics of fixed slots planned around now, the items live slots were added for.
 */
export async function recentCorpus(pool: Pick<Pool, 'query'>, resourceRef: string, now: Date, excludeSlotId: string | null = null): Promise<string[]> {
  const rr = ledgerResource(resourceRef);
  const channelKey = rr.startsWith('telegram:') ? rr.slice('telegram:'.length) : null;
  const { rows } = await pool.query(
    `(SELECT COALESCE(s.rendered_preview, CASE WHEN s.topic_mode = 'fixed' THEN s.topic END, s.live_spec->'item'->>'title') AS text
        FROM editor_slots s
       WHERE COALESCE(s.resource_ref, 'telegram:' || s.channel_key) = $1 AND s.kind = 'content'
         AND ($3::uuid IS NULL OR s.id <> $3)
         AND ((s.status IN ('published','shadowed','awaiting_approval','approved','running') AND s.updated_at > $2::timestamptz - interval '7 days')
           OR (s.status = 'planned' AND s.scheduled_at BETWEEN $2::timestamptz - interval '12 hours' AND $2::timestamptz + interval '24 hours'))
       ORDER BY s.updated_at DESC LIMIT 200)
     UNION ALL
     (SELECT title FROM published_posts WHERE channel_id = $4 AND title IS NOT NULL AND posted_at > $2::timestamptz - interval '7 days'
       ORDER BY posted_at DESC LIMIT 200)
     UNION ALL
     (SELECT caption FROM platform_posts WHERE resource_ref = $1 AND caption IS NOT NULL AND posted_at > $2::timestamptz - interval '7 days'
       ORDER BY posted_at DESC LIMIT 100)`,
    [rr, now, excludeSlotId && /^[0-9a-f-]{36}$/i.test(excludeSlotId) ? excludeSlotId : null, channelKey]);
  return rows.map((r: any) => String(r.text ?? '')).filter(Boolean);
}

export interface FilteredItems<T> {
  kept:    Array<T & { age_hours: number; similar_score: number }>;
  dropped: { old: number; undated: number; posted: number; similar: number };
}

/**
 * Freshness (`sinceHours`), then (with a resource) the ledger and the 7-day similarity check.
 * Items without a link are dropped as undated-equivalent (nothing to cite or dedup).
 */
export async function filterFresh<T extends { title: string | null; link: string | null; age_hours: number | null }>(
  items: T[],
  o: { sinceHours?: number | null; pool?: Pick<Pool, 'query'>; resourceRef?: string | null; now: Date; excludeSlotId?: string | null },
): Promise<FilteredItems<T>> {
  const dropped = { old: 0, undated: 0, posted: 0, similar: 0 };
  let fresh: Array<T & { age_hours: number }> = [];
  for (const it of items) {
    if (!it.link) { dropped.undated++; continue; }
    if (o.sinceHours != null) {
      if (it.age_hours == null) { dropped.undated++; continue; }
      if (it.age_hours > o.sinceHours) { dropped.old++; continue; }
    }
    fresh.push({ ...it, age_hours: it.age_hours ?? -1 });
  }
  if (!o.pool || !o.resourceRef || !fresh.length) return { kept: fresh.map((x) => ({ ...x, similar_score: 0 })), dropped };
  const used = await usedUrls(o.pool, o.resourceRef, [...new Set(fresh.map((x) => x.link!))], o.excludeSlotId ?? null);
  const before = fresh.length;
  fresh = fresh.filter((x) => !used.has(x.link!));
  dropped.posted += before - fresh.length;
  const corpus = fresh.length ? await recentCorpus(o.pool, o.resourceRef, o.now, o.excludeSlotId ?? null) : [];
  const kept: FilteredItems<T>['kept'] = [];
  const seen: string[] = [];
  for (const x of fresh) {
    const score = Math.round(closestRecent(x.title ?? '', [...corpus, ...seen]) * 1000) / 1000;
    if (score >= LIVE_SIMILAR) { dropped.similar++; continue; }
    kept.push({ ...x, similar_score: score });
    // Two feeds often carry the same story: the second copy is a repeat too.
    if (x.title) seen.push(x.title);
  }
  return { kept, dropped };
}

/** A live slot's sources split into feed URLs the code reads and the rest (api:…), resolved against the card. */
export function liveFeeds(sources: string[], card: CardSource[]): { feeds: Array<{ url: string; id: string }>; other: string[] } {
  const feeds: Array<{ url: string; id: string }> = [];
  const other: string[] = [];
  for (const raw of sources) {
    const s = raw.trim();
    if (/^https?:\/\//i.test(s)) { feeds.push({ url: s, id: s }); continue; }
    const id = s.replace(/^(feed|rss):/i, '');
    const src = card.find((c) => c.id === id || c.ref === id);
    if (src && (src.kind === 'rss' || src.kind === 'url') && /^https?:\/\//i.test(src.ref)) feeds.push({ url: src.ref, id: src.id });
    else other.push(s);
  }
  return { feeds: feeds.filter((f, i) => feeds.findIndex((g) => g.url === f.url) === i), other };
}

/**
 * The code-side scan of a live slot before the executor runs: read its feeds, keep fresh unposted
 * non-repeating items, freshest first. The executor sees them in its prompt; zero of them (and no
 * api sources) skips the slot with `no_fresh_item` without an LLM call.
 */
export async function scanLive(
  d: { pool: Pick<Pool, 'query'>; http?: HttpSeams },
  o: { spec: Pick<LiveSpec, 'sources' | 'max_age_hours'>; resourceRef: string; card: CardSource[]; now: Date; excludeSlotId?: string | null },
): Promise<LiveScan> {
  const { feeds, other } = liveFeeds(o.spec.sources, o.card);
  const all: Array<FeedItem & { feed: string }> = [];
  let read = 0;
  let failed = 0;
  for (const f of feeds) {
    try {
      const r = await readFeed(f.url, o.now, d.http);
      read++;
      all.push(...r.items.map((it) => ({ ...it, feed: f.id })));
    } catch {
      failed++;
    }
  }
  const r = await filterFresh(all, { sinceHours: o.spec.max_age_hours, pool: d.pool, resourceRef: o.resourceRef, now: o.now, excludeSlotId: o.excludeSlotId });
  const items: LiveCandidate[] = r.kept
    .sort((a, b) => a.age_hours - b.age_hours)
    .map((x) => ({ title: x.title ?? x.link!, url: x.link!, ageHours: x.age_hours, snippet: x.snippet || null, feed: x.feed }));
  return { items, feedsRead: read, feedsFailed: failed, otherSources: other, dropped: r.dropped };
}
