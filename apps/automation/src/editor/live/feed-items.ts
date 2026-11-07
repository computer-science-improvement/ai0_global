import type { Pool } from 'pg';
import Parser from 'rss-parser';
import type { CardSource } from '../card';
import { safeGet, type RawGet } from '../net/safe-http';
import {
  classifyFetchError, classifyTimeout, classifyTransient, feedKey, hostOf, retryReset, type HostFailures,
} from '../net/host-failures';
import { FEEDISH } from '../sources/playbook-feeds';
import type { Lookup } from '../net/ssrf-guard';
import { ledgerResource } from '../../data/content-ledger';
import { containment, similarity } from '../post/similarity';
import { LIVE_WIDEN_MAX_AGE_HOURS, type LiveCandidate, type LiveScan, type LiveSpec } from './live-slot';
import { errText } from '../../common/err-text';

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

/** The body came back but is not RSS/Atom (spec 040 FR-006: `feed_unparseable`, not a crash of the tool). */
export class FeedParseError extends Error {
  constructor(message: string) { super(message); this.name = 'FeedParseError'; }
}

/** Read one RSS/Atom feed through the SSRF-safe GET. Throws on an HTTP error (`status N`) or FeedParseError. */
export async function readFeed(url: string, now: Date, http: HttpSeams = {}): Promise<{ title: string | null; items: FeedItem[] }> {
  const res = await safeGet(url, { lookup: http.lookup, get: http.get, accept: FEED_ACCEPT });
  if (res.status >= 400) throw new Error(`status ${res.status}`);
  return parseFeedBody(res.body, now);
}

/** Parse an RSS/Atom body that is already fetched (spec 076: the probe reads the body itself). Throws FeedParseError when it is not a feed. */
export async function parseFeedBody(body: string, now: Date): Promise<{ title: string | null; items: FeedItem[] }> {
  let feed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    feed = await parser.parseString(body);
  } catch (err: any) {
    throw new FeedParseError(errText(err).slice(0, 200));
  }
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

/**
 * Spec 076 A19: one feed read for the live scan and the news watch, with the host records `fetch_feed` keeps. An active block
 * (the host, or this feed address) answers without a request. A DNS, TLS, timeout or reset failure is recorded on the host and
 * the address and comes back as `unreachable`. An HTTP status, a body that is not a feed and any other error are `failed`
 * and are NOT recorded: a `url` source is a page, and a `feed_*` row on a page's key would make it look unreachable next time.
 * A read calls `succeeded` on the host and the address.
 */
export type GuardedFeed =
  | { ok: true; feed: { title: string | null; items: FeedItem[] } }
  | { ok: false; unreachable: true; host: string; why: 'blocked' | 'dns' | 'tls' | 'timeout' }
  | { ok: false; unreachable: false; error: string };

export async function readFeedGuarded(
  url: string, now: Date, d: { http?: HttpSeams; hosts?: HostFailures; retryMs?: number } = {},
): Promise<GuardedFeed> {
  const host = hostOf(url);
  const key = feedKey(url);
  if (host && d.hosts) {
    const b = (await d.hosts.blocked(host, 'feed').catch(() => null)) ?? (key ? await d.hosts.blocked(key, 'feed').catch(() => null) : null);
    if (b) return { ok: false, unreachable: true, host, why: 'blocked' };
  }
  let feed: Awaited<ReturnType<typeof readFeed>>;
  try {
    feed = await retryReset(() => readFeed(url, now, d.http), d.retryMs);
  } catch (err: any) {
    if (/^status \d+/.test(err?.message ?? '') || err instanceof FeedParseError) return { ok: false, unreachable: false, error: errText(err) };
    const net = classifyFetchError(err);
    const why: 'dns' | 'tls' | 'timeout' | null = net ?? (classifyTimeout(err) || classifyTransient(err) ? 'timeout' : null);
    if (!why || !host) return { ok: false, unreachable: false, error: errText(err) };
    // A reset that survived the retry is recorded like a timeout (spec 070); the address is recorded too, so a live `refused` row on the host cannot hide it.
    await d.hosts?.record(host, why);
    if (key) await d.hosts?.record(key, why);
    return { ok: false, unreachable: true, host, why };
  }
  if (host) await d.hosts?.succeeded?.(host, 'feed');
  if (key) await d.hosts?.succeeded?.(key, 'feed');
  return { ok: true, feed };
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
                             AND (content_ref_canonical(s.post_spec->'source'->>'url') = content_ref_canonical(u)
                                  OR content_ref_canonical(s.platform_spec->'source'->>'url') = content_ref_canonical(u)))
                         OR (s.status IN ('planned','running') AND s.topic_mode = 'live'
                             AND content_ref_canonical(s.live_spec->'item'->>'url') = content_ref_canonical(u))))`,
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

/** A live slot's sources split into feed URLs the code reads and the rest (api:…), resolved against the card. `kind`: the card source's, or `FEEDISH` for a bare URL (spec 076 A20). */
export function liveFeeds(sources: string[], card: CardSource[]): { feeds: Array<{ url: string; id: string; kind: 'rss' | 'url' }>; other: string[] } {
  const feeds: Array<{ url: string; id: string; kind: 'rss' | 'url' }> = [];
  const other: string[] = [];
  for (const raw of sources) {
    const s = raw.trim();
    if (/^https?:\/\//i.test(s)) { feeds.push({ url: s, id: s, kind: FEEDISH.test(s) ? 'rss' : 'url' }); continue; }
    const id = s.replace(/^(feed|rss):/i, '');
    const src = card.find((c) => c.id === id || c.ref === id);
    if (src && (src.kind === 'rss' || src.kind === 'url') && /^https?:\/\//i.test(src.ref)) feeds.push({ url: src.ref, id: src.id, kind: src.kind });
    else other.push(s);
  }
  return { feeds: feeds.filter((f, i) => feeds.findIndex((g) => g.url === f.url) === i), other };
}

/**
 * The code-side scan of a live slot before the executor runs: read its feeds, keep fresh unposted
 * non-repeating items, freshest first. The executor sees them in its prompt; zero of them (and no
 * api sources) skips the slot with `no_fresh_item` without an LLM call.
 * Spec 076: every entry is read through `readFeedGuarded`. `feedsUnreachable` counts the entries a block or a network failure
 * stopped (a subset of `feedsFailed`); `pageSources` counts the `url` entries, which the writer can still open with web_fetch.
 */
export async function scanLive(
  d: { pool: Pick<Pool, 'query'>; http?: HttpSeams; hosts?: HostFailures; retryMs?: number },
  o: { spec: Pick<LiveSpec, 'sources' | 'max_age_hours'>; resourceRef: string; card: CardSource[]; now: Date; excludeSlotId?: string | null },
): Promise<LiveScan> {
  const { feeds, other } = liveFeeds(o.spec.sources, o.card);
  const all: Array<FeedItem & { feed: string }> = [];
  let read = 0;
  let failed = 0;
  let unreachable = 0;
  for (const f of feeds) {
    const r = await readFeedGuarded(f.url, o.now, { http: d.http, hosts: d.hosts, retryMs: d.retryMs });
    if (r.ok) {
      read++;
      all.push(...r.feed.items.map((it) => ({ ...it, feed: f.id })));
    } else {
      failed++;
      if (r.unreachable) unreachable++;
    }
  }
  const fresh = (sinceHours: number) => filterFresh(all, { sinceHours, pool: d.pool, resourceRef: o.resourceRef, now: o.now, excludeSlotId: o.excludeSlotId });
  let r = await fresh(o.spec.max_age_hours);
  let widenedTo: number | undefined;
  if (!r.kept.length && all.length && o.spec.max_age_hours < LIVE_WIDEN_MAX_AGE_HOURS) {
    const wide = await fresh(LIVE_WIDEN_MAX_AGE_HOURS);
    if (wide.kept.length) { r = wide; widenedTo = LIVE_WIDEN_MAX_AGE_HOURS; }
  }
  const items: LiveCandidate[] = r.kept
    .sort((a, b) => a.age_hours - b.age_hours)
    .map((x) => ({ title: x.title ?? x.link!, url: x.link!, ageHours: x.age_hours, snippet: x.snippet || null, feed: x.feed }));
  return {
    items, feedsRead: read, feedsFailed: failed, feedsUnreachable: unreachable, pageSources: feeds.filter((f) => f.kind === 'url').length,
    otherSources: other, dropped: r.dropped, ...(widenedTo ? { widenedTo } : {}),
  };
}
