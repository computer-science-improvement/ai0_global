import type { Block, InnerBlock, PostSpec } from './post-spec';

/**
 * Spec 063 FR-006: one link per source. Review 3 (5 of 37 posts): the same URL stood twice, as an inline anchor
 * («[за даними TechCrunch](https://…)») and as the code-rendered `→ Source` line / button. The code always renders
 * `spec.source`, so `dropDuplicateSourceLink` keeps that line and turns an inline anchor to the same page into plain
 * text (the words stay, the link goes). An anchor to another page stays.
 *
 * The spec's default was the other way round (keep the inline anchor, drop the arrow line); a PostSpec has no switch
 * to hide the code-rendered source line (grounding, the ledger and the story registry read `spec.source`), so the
 * line wins for every channel.
 */

/** A page address for comparison: host without `www.`, no fragment, no tracking parameters, no trailing slash. */
export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^(?:utm_|fbclid$|gclid$|ref$|ref_src$|source$)/i.test(k)) url.searchParams.delete(k);
    const path = url.pathname.replace(/\/+$/, '');
    const q = url.searchParams.toString();
    return `${url.protocol}//${url.hostname.replace(/^www\./i, '').toLowerCase()}${path}${q ? `?${q}` : ''}`;
  } catch {
    return u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

export const sameSourceUrl = (a: string, b: string): boolean => canonicalUrl(a) === canonicalUrl(b);

const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

/** `[label](url)` → `label` where `url` is the source. */
export function unlinkSource(text: string, sourceUrl: string): string {
  return text.replace(LINK_RE, (m, label: string, url: string) => (sameSourceUrl(url, sourceUrl) ? label : m));
}

function mapBlock<B extends Block | InnerBlock>(b: B, f: (s: string) => string): B {
  switch (b.type) {
    case 'list':
    case 'olist':   return { ...b, items: b.items.map(f) };
    case 'table':   return { ...b, header: b.header.map(f), rows: b.rows.map((r) => r.map(f)) };
    case 'details': return { ...b, title: f(b.title), body: b.body.map((x) => mapBlock(x, f)) };
    case 'code':
    case 'math':
    case 'divider': return b;
    default:        return { ...b, text: f((b as { text: string }).text) } as B;
  }
}

/** The spec without inline links to its own source (body and longread blocks). */
export function dropDuplicateSourceLink(spec: PostSpec): PostSpec {
  const src = spec.source?.url;
  if (!src) return spec;
  const f = (s: string) => unlinkSource(s, src);
  const body = spec.body.map((b) => mapBlock(b, f));
  const out: PostSpec = { ...spec, body };
  if (spec.longread) out.longread = { ...spec.longread, blocks: spec.longread.blocks.map((b) => mapBlock(b, f)) };
  return out;
}
