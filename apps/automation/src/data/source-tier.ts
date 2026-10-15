/**
 * Spec 037 FR-004 (T4): what kind of page a source URL is, pure and in data (not only in the prompts).
 *
 *   • `isSiteIndexUrl` — a site root or a section index (`/`, `/en-US`, `/search`, `/new-and-popular`, `/free-games`,
 *     `/category/x`): it names a site, not the article the post retells (`source_is_homepage`), and it must not fill
 *     the content ledger (one root would block every later post of the site).
 *   • `sourceTier` — `primary` (official blogs, stores, docs, press releases, the authors' arXiv / GitHub /
 *     Hugging Face), `media` (an editorial outlet), `aggregator` (retells other people's articles or offers:
 *     MarkTechPost, GamerPower), `low` ("N fun facts" lists, content farms); null when the domain is not known.
 *
 * The lists are short on purpose: a domain that is not listed is unknown, never guessed.
 */

export type SourceTier = 'primary' | 'media' | 'aggregator' | 'low';
export const SOURCE_TIERS: readonly SourceTier[] = ['primary', 'media', 'aggregator', 'low'];

/** Domains (and their subdomains) by tier. A longer, more specific domain wins (`blog.playstation.com` before `playstation.com`). */
const TIER_DOMAINS: Record<SourceTier, readonly string[]> = {
  aggregator: ['marktechpost.com', 'gamerpower.com', 'gg.deals', 'isthereanydeal.com', 'dealabs.com'],
  low: ['faktypro.com.ua', 'factinate.com', 'thefactsite.com', 'boredpanda.com'],
  media: [
    'techcrunch.com', 'theverge.com', 'dev.ua', 'dou.ua', 'ain.ua', 'itc.ua', 'mezha.media', 'gagadget.com', 'speka.media', 'nv.ua',
    'pravda.com.ua', 'epravda.com.ua', 'suspilne.media', 'engadget.com', 'wired.com', 'arstechnica.com', 'reuters.com', 'bloomberg.com',
    'cnbc.com', 'cnn.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com', 'axios.com', 'theinformation.com', 'zdnet.com', 'theregister.com',
    'venturebeat.com', '9to5mac.com', '9to5google.com', 'macrumors.com', 'androidheadlines.com', 'tomshardware.com', 'ign.com',
    'gamespot.com', 'polygon.com', 'kotaku.com', 'pcgamer.com', 'eurogamer.net', 'rockpapershotgun.com', 'gamesindustry.biz',
    'vgc.com', 'videogameschronicle.com', 'ft.com', 'nytimes.com', 'washingtonpost.com', 'space.com', 'nature.com', 'science.org',
  ],
  primary: [
    // Stores and platform holders.
    'store.steampowered.com', 'steampowered.com', 'steamcommunity.com', 'store.epicgames.com', 'epicgames.com', 'gog.com', 'itch.io',
    'blog.playstation.com', 'playstation.com', 'news.xbox.com', 'xbox.com', 'nintendo.com', 'apps.apple.com', 'play.google.com',
    // AI labs, companies and their blogs / docs.
    'openai.com', 'anthropic.com', 'blog.google', 'deepmind.google', 'ai.google.dev', 'developers.googleblog.com', 'googleblog.com',
    'research.google', 'ai.meta.com', 'about.fb.com', 'mistral.ai', 'huggingface.co', 'github.com', 'github.blog', 'arxiv.org',
    'together.ai', 'liquid.ai', 'qwenlm.github.io', 'nvidia.com', 'blogs.nvidia.com', 'blogs.microsoft.com', 'microsoft.com',
    'apple.com', 'x.ai', 'cohere.com', 'stability.ai', 'deepseek.com', 'ollama.com', 'modelcontextprotocol.io',
    // Press-release wires.
    'prnewswire.com', 'businesswire.com', 'globenewswire.com',
  ],
};

/** Hosts that are docs, developer portals, newsrooms or press rooms of whoever owns the domain. */
const PRIMARY_HOST_RE = /^(?:docs|developer|developers|press|newsroom|investor|investors|ir|blog|engineering|research)\./i;

/** URL paths of "N interesting facts" lists: a low-tier page whatever the site. */
const LOW_PATH_RE = /(?:cikav\w*-fakt|tsikav\w*-fakt|fun-facts?|interesting-facts?|facts-about|\d+-facts|\d+-fakt|faktiv|цікав\w*-факт)/i;

/** Last path segments of a section index, not an article. */
const INDEX_SEGMENTS = new Set([
  'search', 'new-and-popular', 'free-games', 'games', 'news', 'blog', 'blogs', 'articles', 'latest', 'popular', 'trending', 'top',
  'top-sellers', 'topsellers', 'new', 'newest', 'releases', 'upcoming', 'specials', 'deals', 'sales', 'sale', 'giveaways', 'browse',
  'explore', 'store', 'shop', 'discover', 'home', 'index', 'index.html', 'index.php', 'archive', 'archives', 'all', 'feed', 'rss',
  'category', 'categories', 'tag', 'tags', 'topic', 'topics', 'section', 'sections', 'author', 'authors', 'collections',
]);

/** Listing prefixes: `/category/ai`, `/tag/llm`, `/topics/games`, `/author/x` (one more segment) are indexes too. */
const LISTING_PREFIXES = new Set(['category', 'categories', 'tag', 'tags', 'topic', 'topics', 'section', 'sections', 'author', 'authors']);

/** A locale path segment: `en`, `uk`, `en-US`, `pt_BR`. */
const LOCALE_RE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

function parse(url: string): URL | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** The host without `www.`, lower-case; null for a non-http(s) ref. */
export function sourceHost(url: string | null | undefined): string | null {
  const u = url ? parse(url) : null;
  return u ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
}

const pathSegments = (u: URL): string[] => u.pathname.split('/').map((s) => decodeURIComponentSafe(s).trim()).filter(Boolean);

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * A site root or a section index: `https://www.marktechpost.com/`, `https://itch.io/new-and-popular`,
 * `https://store.epicgames.com/en-US/free-games`, `https://store.steampowered.com/search/?specials=1`. An article,
 * a product page or a repo is not (`/p/out-of-sight`, `/2026/10/13/slug`, `/Qwen/Qwen-Image`). False for a
 * non-URL ref (a library / data ref).
 */
export function isSiteIndexUrl(url: string | null | undefined): boolean {
  const u = url ? parse(url) : null;
  if (!u) return false;
  let segs = pathSegments(u);
  if (segs.length && LOCALE_RE.test(segs[0])) segs = segs.slice(1);
  if (!segs.length) return true;
  const last = segs[segs.length - 1].toLowerCase();
  if (segs.length === 1) return INDEX_SEGMENTS.has(last);
  if (segs.length === 2) {
    const first = segs[0].toLowerCase();
    // `/category/ai`, `/news/latest`, `/search/results`; `/blog/<slug>` and `/p/<game>` are articles.
    return LISTING_PREFIXES.has(first) || (INDEX_SEGMENTS.has(first) && INDEX_SEGMENTS.has(last));
  }
  return false;
}

function domainTier(host: string): SourceTier | null {
  let best: { tier: SourceTier; len: number } | null = null;
  for (const tier of SOURCE_TIERS) {
    for (const d of TIER_DOMAINS[tier]) {
      if ((host === d || host.endsWith(`.${d}`)) && (!best || d.length > best.len)) best = { tier, len: d.length };
    }
  }
  return best?.tier ?? null;
}

/**
 * The tier of a source page. `title` (when the page was read) catches a "20 цікавих фактів" list on an unknown site.
 * Null = unknown domain: never counted as primary or low by a guess.
 */
export function sourceTier(url: string | null | undefined, title?: string | null): SourceTier | null {
  const u = url ? parse(url) : null;
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (LOW_PATH_RE.test(u.pathname) || (title && /\d+\s+(?:цікав\p{L}*\s+факт|interesting facts|fun facts|facts about)/iu.test(title))) return 'low';
  const known = domainTier(host);
  if (known) return known;
  if (PRIMARY_HOST_RE.test(host) && host.split('.').length >= 3) return 'primary';
  return null;
}

/** The links of an aggregator page that lead to a primary source (another domain), deduplicated, at most `max`. */
export function primaryLinksOf(pageUrl: string, links: readonly string[], max = 5): string[] {
  const own = sourceHost(pageUrl);
  const out: string[] = [];
  for (const l of links) {
    const host = sourceHost(l);
    if (!host || host === own || isSiteIndexUrl(l) || sourceTier(l) !== 'primary') continue;
    if (!out.includes(l)) out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

export interface TierShare {
  /** Posts with a URL source in the window. */
  total: number;
  counts: Record<SourceTier | 'unknown', number>;
  /** Share 0–1 of each tier (null without sourced posts). */
  share: Record<SourceTier | 'unknown', number> | null;
  /** The most cited domains (≤ 3) with their counts: a resource that lives on one aggregator shows here. */
  top: Array<{ host: string; n: number; tier: SourceTier | null }>;
}

/** The source-tier share of a resource's posts (the MANAGER digest). */
export function tierShare(urls: ReadonlyArray<string | null | undefined>): TierShare {
  const counts: Record<SourceTier | 'unknown', number> = { primary: 0, media: 0, aggregator: 0, low: 0, unknown: 0 };
  const hosts = new Map<string, number>();
  let total = 0;
  for (const url of urls) {
    const host = sourceHost(url);
    if (!host) continue;
    total++;
    counts[sourceTier(url) ?? 'unknown']++;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  const share = total
    ? Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, Math.round((n / total) * 1000) / 1000])) as Record<SourceTier | 'unknown', number>
    : null;
  const top = [...hosts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
    .map(([host, n]) => ({ host, n, tier: domainTier(host) }));
  return { total, counts, share, top };
}
