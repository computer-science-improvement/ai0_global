import { posterOf } from '../post/media/posters';
import type { PosterDecision } from '../post/integrity/checks/media';

/**
 * Spec 037 FR-011 (T11): what the critic knows about the post's images — each image, the network poster it is (name
 * and `use_for`), and the main image of the source page the run read (`null` = the page had none; absent = the page
 * was not read). Spec 067 FR-005: whether a poster fits is decided by code (`PosterDecision`, see `criticMediaLines`), not by
 * the critic.
 */
export interface CriticMediaContext {
  images: Array<{ url: string; poster?: { title: string; useFor: string } }>;
  sourceImage?: string | null;
  /** Spec 037 T17: how many images of the source page a news post may use (main included); absent = unknown. */
  sourceImageCount?: number;
}

/**
 * The context from a spec's media (+ carousel slide backgrounds); null when the post has no image. `sourceImages` (T17)
 * are the page's images a news post may use (main first) — the critic is told only how many there are.
 */
export function criticMediaOf(spec: unknown, sourceImage?: string | null, sourceImages?: readonly string[]): CriticMediaContext | null {
  const s = (spec ?? {}) as { media?: Array<{ url?: unknown; kind?: unknown }>; slides?: Array<{ image?: unknown }> };
  const urls = [
    ...(Array.isArray(s.media) ? s.media : []).filter((m) => m?.kind !== 'video').map((m) => m?.url),
    ...(Array.isArray(s.slides) ? s.slides : []).map((x) => x?.image),
  ].filter((u): u is string => typeof u === 'string' && !!u);
  if (!urls.length) return null;
  return {
    images: [...new Set(urls)].map((url) => {
      const p = posterOf(url);
      return p ? { url, poster: { title: p.title, useFor: p.useFor } } : { url };
    }),
    ...(sourceImage !== undefined ? { sourceImage } : {}),
    ...(sourceImages ? { sourceImageCount: new Set([...(sourceImage ? [sourceImage] : []), ...sourceImages]).size } : {}),
  };
}

/**
 * Spec 067 FR-005 / A5: what the code decided about network posters for this post. The critic sees it for every post, with
 * or without an image, so «пост без картинки» is not held against a post for which no poster applies.
 */
const DECISION_LINE: Record<PosterDecision, string> = {
  news_no_poster: 'Рішення коду: це новина — постер мережі на ній не дозволений, зображення лише зі сторінки-джерела; пост без зображення тут нормальний.',
  poster_fits: 'Рішення коду: до теми підходить постер мережі (його use_for збігається з темою); він доречний, але не обовʼязковий.',
  none_fits: 'Рішення коду: жоден постер мережі до теми не підходить; пост без зображення тут правильний.',
};

/** The «Зображення поста» block of the critic's user prompt; nothing without images and without the code's decision. */
export function criticMediaLines(m: CriticMediaContext | null | undefined, decision?: PosterDecision | null): string[] {
  if (!m?.images.length && !decision) return [];
  const out = ['', '## Зображення поста'];
  if (!m?.images.length) out.push('- зображень у пості немає');
  for (const i of m?.images ?? []) {
    out.push(i.poster ? `- постер мережі «${i.poster.title}», use_for: ${i.poster.useFor}` : `- ${i.url}`);
  }
  const more = m?.sourceImageCount !== undefined ? m.sourceImageCount - 1 : 0;
  if (m?.sourceImage) out.push(`Головне зображення сторінки-джерела: ${m.sourceImage}${more > 0 ? ` (ще ${more} зі статті теж можна, напр. для альбому)` : ''}`);
  else if (m?.sourceImage === null) out.push('Сторінка-джерело без зображення: новина має йти без media.');
  if (decision) out.push(DECISION_LINE[decision]);
  out.push('Чи підходить постер, вирішує код, не ти: постер не за темою чи на новині блокує lint (`poster_mismatch`). format_fit за постер не знижуй, якщо в попередженнях lint немає poster_mismatch; зображення не зі сторінки-джерела в новині — `image_not_from_source`.');
  return out;
}
