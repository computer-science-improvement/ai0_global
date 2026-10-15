import { sourceTier, type SourceTier } from '../../data/source-tier';
import type { AuditSource } from '../post/integrity/types';

/**
 * Spec 037 T17: the pages and feed items one run read, as they are stored with the slot in
 * `editor_slots.critic -> 'sources'` (the critic gate writes them with every verdict). The post audit (T14) and the
 * approval card read them back with `parseSources`, so `image_not_from_source` and the source-date checks work there
 * without reading the page again. No page text is stored (grounding stays a pre-publish check), and the size is
 * capped: ≤ STORED_SOURCES_MAX entries (the post's own source first), ≤ STORED_IMAGES_MAX images each, long titles cut,
 * over-long URLs dropped.
 */
export interface StoredSource {
  url:          string;
  publishedAt?: string | null;
  title?:       string | null;
  tier?:        SourceTier;
  /** The page's main image; null = the page was read and had none; absent = unknown (a feed item). */
  image?:       string | null;
  /** Every image of the page a news post may use (main first). */
  images?:      string[];
}

export const STORED_SOURCES_MAX = 6;
export const STORED_IMAGES_MAX = 10;
const TITLE_MAX = 200;
const URL_MAX = 2000;

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const okUrl = (u: unknown): u is string => typeof u === 'string' && u.length <= URL_MAX && /^https?:\/\//i.test(u);

/** The run's sources in their stored, capped form; the one the post cites (`citedUrl`) first. */
export function storedSourcesOf(sources: readonly AuditSource[], citedUrl?: string | null): StoredSource[] {
  const cited = citedUrl ? normUrl(citedUrl) : null;
  const ordered = [...sources.filter((s) => cited && normUrl(s.url) === cited), ...sources.filter((s) => !cited || normUrl(s.url) !== cited)];
  const out: StoredSource[] = [];
  const seen = new Set<string>();
  for (const s of ordered) {
    if (!okUrl(s.url) || seen.has(normUrl(s.url))) continue;
    seen.add(normUrl(s.url));
    const tier = sourceTier(s.url, s.title ?? null);
    const images = s.images?.filter(okUrl).slice(0, STORED_IMAGES_MAX);
    out.push({
      url: s.url,
      ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
      ...(s.title ? { title: s.title.slice(0, TITLE_MAX) } : {}),
      ...(tier ? { tier } : {}),
      ...(s.image === null || okUrl(s.image) ? { image: s.image } : {}),
      ...(images ? { images } : {}),
    });
    if (out.length >= STORED_SOURCES_MAX) break;
  }
  return out;
}
