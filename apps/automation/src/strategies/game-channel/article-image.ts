// Pure helper: extract the hero image a page preloads via
//   <link rel="preload" as="image" href="...">
// PC Gamer exposes its article image this way but NOT in the RSS item, so the
// game-channel strategy pulls it from the article HTML. Attribute order is not
// guaranteed, so we match `rel`/`as` independently of position. No I/O — testable.

const ENTITIES: Record<string, string> = { '&amp;': '&', '&#38;': '&', '&#x26;': '&' };

function decode(s: string): string {
  let out = s;
  for (const [ent, ch] of Object.entries(ENTITIES)) out = out.split(ent).join(ch);
  return out;
}

/** First `<link rel="preload" as="image" href="...">` href, or null. */
export function extractPreloadImage(html: string): string | null {
  if (!html) return null;
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    if (/\brel\s*=\s*["']preload["']/i.test(tag) && /\bas\s*=\s*["']image["']/i.test(tag)) {
      const m = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
      if (m) return decode(m[1].trim());
    }
  }
  return null;
}
