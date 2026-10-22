import * as cheerio from 'cheerio';
import { normalizePublishedAt } from '../post/dates';
import { primaryLinksOf, sourceTier } from '../../data/source-tier';
import { normalizeImageUrl } from '../post/media/image-url';
import type { RawSection } from '../docs/doc-types';

export interface ExtractedPage {
  title:       string | null;
  description: string | null;
  /** Spec 037 T11: the page's main image — og:image, twitter:image, else the first article image (absolute); null = none. */
  image:       string | null;
  /**
   * Spec 037 T17: the page's images a news post may use — the main image first, then the article's own images
   * (≤ 10, absolute http(s), deduplicated, page chrome filtered out; see `articleImagesOf`).
   */
  images:      string[];
  text:        string;
  /** Spec 037 T5: when the page says it was published (ISO instant or YYYY-MM-DD); null when it does not. */
  published_at: string | null;
  /** Spec 037 T4: an aggregator page's links to the primary source on another site (absent when none / not an aggregator). */
  primary_links?: string[];
}

/** Spec 053 FR-003: every later step re-sends the page — 6k characters carry the facts of a news page. */
export const TEXT_MAX = 6_000;

/** Readable text + key metadata from an HTML page, for the model to read. */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  return extractPageFull(html, baseUrl).page;
}

/** An HTML page read whole (spec 065): the page as `extractPage` shows it, plus the full text and its sections. */
export interface ExtractedDocument {
  page:     ExtractedPage;
  /** The text before the `TEXT_MAX` cut; `page.text` is this when it is short enough. */
  fullText: string;
  /** Sections by h1–h3 headings over `fullText` (an intro first when text precedes the first heading); the article's images sit in them. */
  sections: RawSection[];
}

const TEXT_BLOCKS = 'h1, h2, h3, p, li, blockquote';

export function extractPageFull(html: string, baseUrl: string): ExtractedDocument {
  const $ = cheerio.load(html);
  const abs = (u: string | undefined | null): string | null => {
    if (!u) return null;
    try { return new URL(u, baseUrl).toString(); } catch { return null; }
  };
  const meta = (sel: string) => $(sel).attr('content')?.trim() || null;

  const title = meta('meta[property="og:title"]') ?? ($('title').first().text().trim() || null);
  const description = meta('meta[property="og:description"]') ?? meta('meta[name="description"]');
  const socialImage = metaImageOf($, abs);
  const published_at = publishedAtOf($);

  $('script, style, noscript, nav, footer, header, aside, form, iframe, svg').remove();
  const root = $('article').first().length ? $('article').first() : ($('main').first().length ? $('main').first() : $('body'));

  const article = articleImagesOf($, root, abs);
  const image = socialImage ?? article[0] ?? null;

  const blocks = root.find(TEXT_BLOCKS).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
    .filter((t) => t.length > 1);
  const fullText = (blocks.length ? blocks.join('\n') : root.text().replace(/\s+/g, ' ')).trim();
  let text = fullText;
  if (text.length > TEXT_MAX) text = `${text.slice(0, TEXT_MAX)}…`;

  // Spec 037 T4: an aggregator (MarkTechPost, GamerPower) retells a primary source; its links to it are the better source.
  const primary = sourceTier(baseUrl) === 'aggregator'
    ? primaryLinksOf(baseUrl, root.find('a[href]').map((_, el) => abs($(el).attr('href'))).get().filter((u): u is string => !!u))
    : [];

  const page: ExtractedPage = {
    title, description, image, images: dedupeImages([...(image ? [image] : []), ...article]), text, published_at,
    ...(primary.length ? { primary_links: primary } : {}),
  };
  return { page, fullText, sections: htmlSections($, root, blocks.length > 0, fullText, new Set(article.map(normalizeImageUrl)), abs, title) };
}

/** The src of an `<img>` the way `articleImagesOf` reads it (lazy-load attributes after `src`). */
function imgSrc($img: cheerio.Cheerio<any>, abs: (u: string | undefined | null) => string | null): string | null {
  const raw = [$img.attr('src'), $img.attr('data-src'), $img.attr('data-lazy-src'), $img.attr('data-original')]
    .map((v) => v?.trim()).find((v) => !!v && !/^data:/i.test(v));
  return abs(raw);
}

/**
 * Spec 065 FR-002: sections of an HTML page by its h1–h3 headings, as offsets into the same text `extractPage` builds,
 * with the article's images (the ones `articleImagesOf` kept) in the section they sit in. No headings: one section.
 */
function htmlSections(
  $: cheerio.CheerioAPI, root: cheerio.Cheerio<any>, hasBlocks: boolean, fullText: string,
  kept: Set<string>, abs: (u: string | undefined | null) => string | null, title: string | null,
): RawSection[] {
  const sections: RawSection[] = [];
  const whole = (): RawSection[] => (fullText ? [{ heading: title ?? '', level: 1, start: 0, end: fullText.length, images: [], links: [], code_blocks: [] }] : []);
  if (!hasBlocks) return whole();
  let pos = 0;
  let cur: RawSection | null = null;
  const open = (heading: string, level: number, at: number) => {
    if (cur) cur.end = at;
    cur = { heading, level, start: at, end: fullText.length, images: [], links: [], code_blocks: [] };
    sections.push(cur);
  };
  root.find(`${TEXT_BLOCKS}, img`).each((_, el) => {
    const $el = $(el);
    if (el.tagName === 'img') {
      const u = imgSrc($el, abs);
      if (!u || !kept.has(normalizeImageUrl(u))) return;
      if (!cur) open('', 1, pos);
      if (!cur!.images.some((i) => i.src === u)) cur!.images.push({ src: u, alt: ($el.attr('alt') ?? '').trim(), at: pos });
      return;
    }
    const t = $el.text().replace(/\s+/g, ' ').trim();
    if (t.length <= 1) return;
    const level = /^h([1-3])$/.exec(el.tagName)?.[1];
    if (level) open(t, Number(level), pos);
    else if (!cur) open('', 1, pos);
    pos += t.length + 1;
  });
  return sections.length ? sections : whole();
}

/** How many page images are kept (the main one included). */
export const PAGE_IMAGES_MAX = 10;
/** A declared width or height at or below this is an icon, a spacer or a tracking pixel. */
const TINY_PX = 64;
/** Names of page chrome: a path segment / file-name part `logo`, `icon(s)`, `avatar`, `sprite`, `badge`, `favicon`, `emoji`… */
const CHROME_NAME = /(?:^|[/_.-])(?:logos?|icons?|favicons?|avatars?|sprites?|badges?|emojis?|spinner|placeholder|gravatar|userpic)(?=$|[/_.\d-])/i;
/** A file named as a tracking pixel or spacer (`pixel.gif`, `tracking-pixel.png`, `1x1.png`, `spacer.gif`, `blank.png`). */
const PIXEL_FILE = /(?:^|[/_-])(?:pixel|px|1x1|spacer|blank|transparent|tracking)\.[a-z0-9]+$/i;
/** Classes / ids of page chrome. */
const CHROME_ATTR = /(?:^|[\s_-])(?:logo|icon|avatar|emoji|badge|sprite|author-photo|byline)(?=$|[\s_-])/i;

const dimOf = (v: string | undefined): number | null => {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Distinct images (by `normalizeImageUrl`), first occurrence kept, at most PAGE_IMAGES_MAX. */
function dedupeImages(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const k = normalizeImageUrl(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
    if (out.length >= PAGE_IMAGES_MAX) break;
  }
  return out;
}

/**
 * Spec 037 T17: the article's own images (the root the text is read from; nav / header / footer / aside are already
 * gone), in page order, absolute http(s), deduplicated, ≤ PAGE_IMAGES_MAX. Page chrome is skipped by simple rules:
 *   • `data:` URIs and anything not http(s) (also how lazy-load placeholders usually look);
 *   • `.svg` (logos, icons) and `.gif` (tracking pixels, spacers; an animated GIF is not a post photo);
 *   • a declared `width` or `height` ≤ 64 px (icons, avatars, 1×1 pixels);
 *   • a path / file name with logo, icon, favicon, avatar, sprite, badge, emoji, spinner, placeholder, gravatar,
 *     userpic, or a pixel / spacer file (`pixel.png`, `1x1.png`, `spacer.gif`);
 *   • a class / id naming logo, icon, avatar, emoji, badge, sprite, author photo, byline (not the alt: a news photo
 *     may well show a logo).
 * The source is `src`, else `data-src` / `data-lazy-src` / `data-original` (lazy loading).
 */
export function articleImagesOf($: cheerio.CheerioAPI, root: cheerio.Cheerio<any>, abs: (u: string | undefined | null) => string | null): string[] {
  const out: string[] = [];
  root.find('img').each((_, el) => {
    const img = $(el);
    const raw = [img.attr('src'), img.attr('data-src'), img.attr('data-lazy-src'), img.attr('data-original')]
      .map((v) => v?.trim()).find((v) => !!v && !/^data:/i.test(v));
    const u = abs(raw);
    if (!u || !/^https?:\/\//i.test(u)) return;
    let path: string;
    try { path = decodeURIComponent(new URL(u).pathname); } catch { return; }
    if (/\.(?:svg|gif)$/i.test(path)) return;
    const w = dimOf(img.attr('width'));
    const h = dimOf(img.attr('height'));
    if ((w !== null && w <= TINY_PX) || (h !== null && h <= TINY_PX)) return;
    if (CHROME_NAME.test(path) || PIXEL_FILE.test(path)) return;
    if (CHROME_ATTR.test([img.attr('class'), img.attr('id')].filter(Boolean).join(' '))) return;
    out.push(u);
  });
  return dedupeImages(out);
}

/** Social-card image selectors in priority order (og:image and its aliases, then twitter:image). */
const META_IMAGE = [
  'meta[property="og:image:secure_url"]', 'meta[property="og:image"]', 'meta[name="og:image"]', 'meta[property="og:image:url"]',
  'meta[name="twitter:image"]', 'meta[property="twitter:image"]', 'meta[name="twitter:image:src"]', 'meta[property="twitter:image:src"]',
];

/**
 * Spec 037 T11: the page's social-card image (og:image, then twitter:image), absolute, http(s) only; null when the
 * page declares none. Read before the head is stripped; the article's first image is the caller's fallback.
 */
export function metaImageOf($: cheerio.CheerioAPI, abs: (u: string | undefined | null) => string | null): string | null {
  for (const sel of META_IMAGE) {
    const u = abs($(sel).first().attr('content')?.trim());
    if (u && /^https?:/i.test(u)) return u;
  }
  return null;
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
