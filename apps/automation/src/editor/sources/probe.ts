import type { Pool } from 'pg';
import * as cheerio from 'cheerio';
import { canonicalUrl } from '../docs/doc-store';
import {
  classifyFetchError, classifyTimeout, classifyTransient, feedKey, hostOf, isTooLarge, PgHostFailures, REFUSAL_STATUSES, RESET_RETRY_MS,
  type HostBlock, type HostFailures,
} from '../net/host-failures';
import { extractPageFull } from '../net/extract-page';
import { egressProxyFor, safeGet, type SafeGetResult } from '../net/safe-http';
import { assertPublicUrl } from '../net/ssrf-guard';
import { parseFeedBody, type FeedItem, type HttpSeams } from '../live/feed-items';
import { PgSourceProbes } from './source-probes.repository';
import { errText } from '../../common/err-text';

/**
 * Spec 076 FR-001: read a source address once from the SERVER and say what came back — the check nobody did before a channel
 * went live (zakon.rada.gov.ua answers nothing from the droplet; a card with a dead feed looked fine for two weeks). $0, no model.
 *
 * The steps, in order: syntax (`invalid`) → cache (6 h, `cacheOnly` stops here) → an active host block (answered without a
 * request) → the SSRF guard → the read (a second try only after a timeout or reset) → classify the answer → record on the
 * host → store. A probe never records a `feed_*` reason, and an `rss` probe records nothing for an HTTP status (A33): a feed that
 * answers 403 is not a host that refuses its pages. `invalid` (a bad or private address) is not cached, stored or recorded.
 */

export const PROBE_CACHE_HOURS = 6;
export const PROBE_TIMEOUT_MS = 10_000;
/** A page with less text than this is `empty` (A12). */
export const PROBE_MIN_PAGE_CHARS = 200;
export const PROBE_TITLES = 5;

export type ProbeFailureClass = 'timeout' | 'refused' | 'tls' | 'dns' | 'http' | 'empty' | 'invalid';

export interface ProbeResult {
  ok:            boolean;
  failure_class: ProbeFailureClass | null;     // null when ok
  status:        number | null;                // the last HTTP status; null when nothing answered
  kind:          'rss' | 'page';
  feed_url:      string | null;                // the feed read: the URL itself, or the feed a page names
  items:         number;
  newest_at:     string | null;                // ISO
  sample_titles: string[];                     // at most 5, each at most 120 chars
  checked_at:    string;                       // ISO
  via_proxy:     boolean;
  url:           string;                       // canonicalUrl of the address
  detail:        string;                       // one English line: "24 items, newest 2 h ago" / "timed out twice (10 s)"
  ms:            number | null;
  cached:        boolean;
  blocked_until: string | null;                // set when a host block answered without a request
}

export type ProbeSummary = Pick<ProbeResult, 'ok' | 'failure_class' | 'status' | 'kind' | 'items' | 'newest_at' | 'checked_at' | 'via_proxy' | 'detail'>;

/** The part of a probe that source health, the doctor and the panel carry (no titles, no addresses). */
export const summaryOf = (r: ProbeResult): ProbeSummary => ({
  ok: r.ok, failure_class: r.failure_class, status: r.status, kind: r.kind, items: r.items, newest_at: r.newest_at,
  checked_at: r.checked_at, via_proxy: r.via_proxy, detail: r.detail,
});

/** The cache of probes (`source_probes`); without one nothing is cached. */
export interface SourceProbeStore {
  get(url: string): Promise<ProbeResult | null>;
  put(result: ProbeResult): Promise<void>;
}

export interface ProbeOpts {
  kind?:      'rss' | 'url';                  // the card's kind; when absent, detected from the answer
  force?:     boolean;                        // skip the cache and an active host block
  maxAgeMs?:  number;                         // the cache age that counts; default PROBE_CACHE_HOURS (6 h)
  cacheOnly?: boolean;                        // no request: the stored row within maxAgeMs, else null
  store?:     SourceProbeStore;
  hosts?:     HostFailures;                   // block check, record and succeeded; without it neither
  http?:      HttpSeams;                      // test seams (lookup, get)
  env?:       (k: string) => string | undefined; // the proxy settings (A29)
  now?:       () => Date;
  /** Pause before the one more try after a timeout or reset; tests pass 0. */
  retryMs?:   number;
}

export function probeSource(url: string, opts: ProbeOpts & { cacheOnly: true }): Promise<ProbeResult | null>;
export function probeSource(url: string, opts?: ProbeOpts): Promise<ProbeResult>;
export async function probeSource(url: string, opts: ProbeOpts = {}): Promise<ProbeResult | null> {
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const canon = canonicalUrl(url);
  const kind: 'rss' | 'page' = opts.kind === 'rss' ? 'rss' : 'page';
  const base = (over: Partial<ProbeResult>): ProbeResult => ({
    ok: false, failure_class: null, status: null, kind, feed_url: null, items: 0, newest_at: null, sample_titles: [],
    checked_at: now().toISOString(), via_proxy: false, url: canon, detail: '', ms: null, cached: false, blocked_until: null, ...over,
  });

  // 1. Syntax.
  const host = hostOf(url);
  if (!host) return base({ failure_class: 'invalid', detail: 'not an http(s) address' });

  // 2. Cache.
  if (!opts.force || opts.cacheOnly) {
    const hit = await opts.store?.get(canon).catch(() => null);
    const maxAge = opts.maxAgeMs ?? PROBE_CACHE_HOURS * 3_600_000;
    if (hit && now().getTime() - Date.parse(hit.checked_at) <= maxAge) return { ...hit, cached: true };
  }
  if (opts.cacheOnly) return null;

  // 3. An active block answers without a request (a block of the host's pages, or of this feed address).
  const key = opts.kind === 'rss' ? feedKey(url) : null;
  if (!opts.force && opts.hosts) {
    const use = opts.kind === 'rss' ? 'feed' : 'page';
    const b = (await opts.hosts.blocked(host, use)) ?? (key ? await opts.hosts.blocked(key, 'feed') : null);
    if (b) return base({ failure_class: blockClass(b), status: b.statusCode, detail: `blocked until ${stamp(b.until)} (${b.reason})`, blocked_until: b.until.toISOString() });
  }

  // 4. The SSRF guard. A DNS failure is a result (recorded); any other refusal is our own: `invalid`, not recorded.
  try {
    await assertPublicUrl(url, opts.http?.lookup);
  } catch (err) {
    if (classifyFetchError(err) === 'dns' || /does not resolve/i.test(errText(err))) {
      await recordNetwork(opts, host, key, 'dns');
      return finish(opts, base({ failure_class: 'dns', detail: 'the domain does not resolve (DNS)', via_proxy: viaProxy(host, opts) }), started);
    }
    return base({ failure_class: 'invalid', detail: 'not a public address' });
  }

  // 5. Read, then classify.
  const read = await readTwice(url, opts);
  if (!read.ok) {
    const f = failureOf(read.err, read.tries);
    if (f.record) await recordNetwork(opts, host, key, f.record);
    return finish(opts, base({ failure_class: f.class, detail: f.detail, via_proxy: viaProxy(host, opts) }), started);
  }
  const res = read.res;
  const out = await classifyAnswer(res, opts, base);

  // 6. Record: any answer under 400 means the host was reached; a refusal of a page is the host's (a feed's refusal is not).
  if (res.status < 400) {
    if (opts.kind === 'rss') {
      await opts.hosts?.succeeded?.(host, 'feed');
      if (key) await opts.hosts?.succeeded?.(key, 'feed');
    } else {
      await opts.hosts?.succeeded?.(host, 'page');
    }
  } else if (REFUSAL_STATUSES.has(res.status) && opts.kind !== 'rss') {
    await opts.hosts?.record(host, 'refused', res.status).catch(() => {});
  }
  return finish(opts, out, started);
}

/** The class a host block gives an answer made without a request. */
function blockClass(b: HostBlock): ProbeFailureClass {
  switch (b.reason) {
    case 'timeout': case 'unreachable': return 'timeout';
    case 'refused': case 'feed_refused': return 'refused';
    case 'dns': return 'dns';
    case 'tls': return 'tls';
    case 'feed_unparseable': return 'empty';
    default: return 'http'; // feed_missing, feed_too_large
  }
}

const stamp = (d: Date): string => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const viaProxy = (host: string, o: ProbeOpts): boolean => egressProxyFor(host, o.env) !== null;

/** Network failures go on the host and, for a feed, on the feed address too (as `fetch_feed` does). */
async function recordNetwork(o: ProbeOpts, host: string, key: string | null, reason: 'timeout' | 'dns' | 'tls'): Promise<void> {
  await o.hosts?.record(host, reason).catch(() => {});
  if (key) await o.hosts?.record(key, reason).catch(() => {});
}

/** Sets `ms`, stores the result (never an `invalid` one) and returns it. A failing store never fails the probe. */
async function finish(o: ProbeOpts, r: ProbeResult, started: number): Promise<ProbeResult> {
  const out = { ...r, ms: Date.now() - started };
  if (o.store && out.failure_class !== 'invalid') await o.store.put(out).catch(() => {});
  return out;
}

const PROBE_ACCEPT = 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.5';

/** One try, and a second only after a timeout or reset (DNS and TLS errors are final). */
async function readTwice(url: string, o: ProbeOpts): Promise<{ ok: true; res: SafeGetResult } | { ok: false; err: unknown; tries: number }> {
  let err: unknown;
  for (let tries = 1; tries <= 2; tries++) {
    try {
      const res = await safeGet(url, { lookup: o.http?.lookup, get: o.http?.get, timeoutMs: PROBE_TIMEOUT_MS, accept: PROBE_ACCEPT, env: o.env });
      return { ok: true, res };
    } catch (e) {
      err = e;
      const again = !classifyFetchError(e) && (classifyTimeout(e) || classifyTransient(e));
      if (!again || tries === 2) return { ok: false, err: e, tries };
      const ms = o.retryMs ?? RESET_RETRY_MS;
      if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
    }
  }
  return { ok: false, err, tries: 2 };
}

/** What a failed read is: the class, a line for the owner, and what to record on the host (null = nothing: not the host's fault). */
function failureOf(err: unknown, tries: number): { class: ProbeFailureClass; detail: string; record: 'timeout' | 'dns' | 'tls' | null } {
  const net = classifyFetchError(err);
  if (net === 'dns') return { class: 'dns', detail: 'the domain does not resolve (DNS)', record: 'dns' };
  if (net === 'tls') return { class: 'tls', detail: 'TLS certificate error', record: 'tls' };
  const secs = PROBE_TIMEOUT_MS / 1000;
  if (classifyTimeout(err)) return { class: 'timeout', detail: tries > 1 ? `timed out twice (${secs} s)` : `timed out (${secs} s)`, record: 'timeout' };
  if (classifyTransient(err)) return { class: 'timeout', detail: tries > 1 ? 'connection cut twice' : 'connection cut', record: 'timeout' };
  if (isTooLarge(err)) return { class: 'http', detail: 'the answer is larger than 2 MB', record: null };
  // Anything no classifier knows (a redirect to a private address, too many redirects …): an answer, not a host failure.
  return { class: 'http', detail: errText(err).slice(0, 120), record: null };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const agoText = (hours: number): string => (hours < 1 ? 'under an hour ago' : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} d ago`);

/** The feed's items as the probe reports them: count, newest date and up to five titles. */
function summarizeFeed(items: FeedItem[], now: Date): Pick<ProbeResult, 'items' | 'newest_at' | 'sample_titles'> & { newestAge: number | null } {
  const times = items.map((i) => (i.date ? new Date(i.date).getTime() : NaN)).filter((t) => !Number.isNaN(t));
  const newest = times.length ? Math.max(...times) : null;
  return {
    items: items.length,
    newest_at: newest === null ? null : new Date(newest).toISOString(),
    sample_titles: items.map((i) => (i.title ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, PROBE_TITLES).map((t) => clip(t, 120)),
    newestAge: newest === null ? null : Math.max(0, (now.getTime() - newest) / 3_600_000),
  };
}

const feedLine = (n: number, age: number | null): string => `${n} item${n === 1 ? '' : 's'}${age === null ? ', no dates' : `, newest ${agoText(age)}`}`;

/** The first `<link rel="alternate" type="application/rss+xml | atom+xml">` of a page, absolute; null for none. */
export function discoverFeed(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  for (const el of $('link[rel~="alternate"]').toArray()) {
    const type = ($(el).attr('type') ?? '').toLowerCase();
    const href = $(el).attr('href')?.trim();
    if (!href || !/application\/(rss|atom)\+xml/.test(type)) continue;
    try { return new URL(href, baseUrl).toString(); } catch { /* next */ }
  }
  return null;
}

async function classifyAnswer(res: SafeGetResult, o: ProbeOpts, base: (over: Partial<ProbeResult>) => ProbeResult): Promise<ProbeResult> {
  const now = (o.now ?? (() => new Date()))();
  const common = { status: res.status, via_proxy: res.via_proxy };
  if (res.status >= 400) {
    return REFUSAL_STATUSES.has(res.status)
      ? base({ ...common, failure_class: 'refused', detail: `HTTP ${res.status}: the site refuses the server` })
      : base({ ...common, failure_class: 'http', detail: `HTTP ${res.status}` });
  }
  // A body that parses as RSS or Atom is a feed, whatever the card says.
  try {
    const feed = await parseFeedBody(res.body, now);
    const s = summarizeFeed(feed.items, now);
    if (!feed.items.length) return base({ ...common, kind: 'rss', feed_url: canonicalUrl(res.url), failure_class: 'empty', detail: 'the feed has no items' });
    return base({ ...common, ok: true, kind: 'rss', feed_url: canonicalUrl(res.url), items: s.items, newest_at: s.newest_at, sample_titles: s.sample_titles, detail: feedLine(s.items, s.newestAge) });
  } catch { /* not a feed: a page */ }

  const named = discoverFeed(res.body, res.url);
  if (o.kind === 'rss') {
    // A card says this is a feed. The page it names is not read: the owner picks the address (A12).
    return base({ ...common, failure_class: 'empty', kind: 'page', feed_url: named, detail: `not a feed${named ? `; the page names the feed ${named}` : ''}` });
  }
  const doc = extractPageFull(res.body, res.url);
  const chars = doc.fullText.length;
  const headings = doc.sections.map((s) => s.heading.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, PROBE_TITLES).map((t) => clip(t, 120));
  const published = doc.page.published_at && !Number.isNaN(Date.parse(doc.page.published_at)) ? new Date(doc.page.published_at).toISOString() : null;
  const pageResult = (extra: Partial<ProbeResult> = {}): ProbeResult => chars < PROBE_MIN_PAGE_CHARS
    ? base({ ...common, failure_class: 'empty', detail: `the page has ${chars} characters of text`, ...extra })
    : base({ ...common, ok: true, items: doc.page.primary_links?.length ?? 0, newest_at: published, sample_titles: headings, detail: `page, ${chars} chars`, ...extra });

  if (!named) return pageResult();
  // The page names a feed: read it once, by the same rules; its items are the result. If it fails the page result stays and says why.
  const feedRead = await readTwice(named, o);
  if (!feedRead.ok) return pageResult({ feed_url: named, detail: `${pageResult().detail}; its feed ${named} failed: ${failureOf(feedRead.err, feedRead.tries).detail}` });
  if (feedRead.res.status >= 400) return pageResult({ feed_url: named, detail: `${pageResult().detail}; its feed ${named} answered HTTP ${feedRead.res.status}` });
  try {
    const feed = await parseFeedBody(feedRead.res.body, now);
    const s = summarizeFeed(feed.items, now);
    if (!feed.items.length) return pageResult({ feed_url: named, detail: `${pageResult().detail}; its feed ${named} has no items` });
    return base({ ...common, ok: true, feed_url: named, items: s.items, newest_at: s.newest_at, sample_titles: s.sample_titles, detail: `${feedLine(s.items, s.newestAge)} (feed ${named})` });
  } catch {
    return pageResult({ feed_url: named, detail: `${pageResult().detail}; its feed ${named} is not readable as RSS or Atom` });
  }
}

/** A prober bound to the real cache and the real host record (what 074, 077 and the workers call). */
export type ProberOpts = Pick<ProbeOpts, 'kind' | 'force' | 'maxAgeMs' | 'cacheOnly'>;
export interface SourceProber {
  (url: string, o: ProberOpts & { cacheOnly: true }): Promise<ProbeResult | null>;
  (url: string, o?: ProberOpts): Promise<ProbeResult>;
}

export function sourceProberOf(pool: Pick<Pool, 'query'>, env?: (k: string) => string | undefined): SourceProber {
  const store = new PgSourceProbes(pool);
  const hosts = new PgHostFailures(pool);
  return ((url: string, o: ProberOpts = {}) => probeSource(url, { ...o, store, hosts, ...(env ? { env } : {}) })) as SourceProber;
}
