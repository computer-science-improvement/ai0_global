import * as cheerio from 'cheerio';
import { normalizePublishedAt } from '../post/dates';

export interface ExtractedPage {
  title:       string | null;
  description: string | null;
  image:       string | null;
  images:      string[];
  text:        string;
  /** Spec 037 T5: when the page says it was published (ISO instant or YYYY-MM-DD); null when it does not. */
  published_at: string | null;
}

const TEXT_MAX = 12_000;

/** Readable text + key metadata from an HTML page, for the model to read. */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const abs = (u: string | undefined | null): string | null => {
    if (!u) return null;
    try { return new URL(u, baseUrl).toString(); } catch { return null; }
  };
  const meta = (sel: string) => $(sel).attr('content')?.trim() || null;

  const title = meta('meta[property="og:title"]') ?? ($('title').first().text().trim() || null);
  const description = meta('meta[property="og:description"]') ?? meta('meta[name="description"]');
  const image = abs(meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]'));
  const published_at = publishedAtOf($);

  $('script, style, noscript, nav, footer, header, aside, form, iframe, svg').remove();
  const root = $('article').first().length ? $('article').first() : ($('main').first().length ? $('main').first() : $('body'));

  const images = root.find('img').map((_, el) => abs($(el).attr('src') ?? $(el).attr('data-src'))).get()
    .filter((u): u is string => !!u && /^https?:/.test(u) && !/\.(svg|gif)(\?|$)/i.test(u));

  const blocks = root.find('h1, h2, h3, p, li, blockquote').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
    .filter((t) => t.length > 1);
  let text = (blocks.length ? blocks.join('\n') : root.text().replace(/\s+/g, ' ')).trim();
  if (text.length > TEXT_MAX) text = `${text.slice(0, TEXT_MAX)}…`;

  return { title, description, image, images: [...new Set(images)].slice(0, 10), text, published_at };
}

/** A `datePublished` anywhere in a JSON-LD value (an object, an array, a `@graph`). */
function ldDate(v: unknown, depth = 0): string | null {
  if (!v || typeof v !== 'object' || depth > 4) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const d = ldDate(x, depth + 1);
      if (d) return d;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  const own = normalizePublishedAt(o.datePublished);
  if (own) return own;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage']) {
    const d = ldDate(o[k], depth + 1);
    if (d) return d;
  }
  return null;
}

/**
 * Spec 037 T5: the page's publication date — `article:published_time` (and its common aliases), JSON-LD
 * `datePublished`, then `<time datetime>` (the one marked datePublished first). Read before scripts are removed.
 */
export function publishedAtOf($: cheerio.CheerioAPI): string | null {
  for (const sel of [
    'meta[property="article:published_time"]', 'meta[name="article:published_time"]', 'meta[property="og:published_time"]',
    'meta[itemprop="datePublished"]', 'meta[name="parsely-pub-date"]', 'meta[name="pubdate"]', 'meta[name="publishdate"]', 'meta[name="date"]',
  ]) {
    const d = normalizePublishedAt($(sel).attr('content'));
    if (d) return d;
  }
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const d = ldDate(JSON.parse($(el).contents().text()));
      if (d) return d;
    } catch { /* malformed JSON-LD is common */ }
  }
  const time = $('time[itemprop="datePublished"][datetime]').first().attr('datetime') ?? $('time[datetime]').first().attr('datetime');
  return normalizePublishedAt(time);
}
