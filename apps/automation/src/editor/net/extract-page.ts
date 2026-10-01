import * as cheerio from 'cheerio';

export interface ExtractedPage {
  title:       string | null;
  description: string | null;
  image:       string | null;
  images:      string[];
  text:        string;
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

  $('script, style, noscript, nav, footer, header, aside, form, iframe, svg').remove();
  const root = $('article').first().length ? $('article').first() : ($('main').first().length ? $('main').first() : $('body'));

  const images = root.find('img').map((_, el) => abs($(el).attr('src') ?? $(el).attr('data-src'))).get()
    .filter((u): u is string => !!u && /^https?:/.test(u) && !/\.(svg|gif)(\?|$)/i.test(u));

  const blocks = root.find('h1, h2, h3, p, li, blockquote').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
    .filter((t) => t.length > 1);
  let text = (blocks.length ? blocks.join('\n') : root.text().replace(/\s+/g, ' ')).trim();
  if (text.length > TEXT_MAX) text = `${text.slice(0, TEXT_MAX)}…`;

  return { title, description, image, images: [...new Set(images)].slice(0, 10), text };
}
