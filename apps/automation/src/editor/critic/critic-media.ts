import { posterOf } from '../post/media/posters';

/**
 * Spec 037 FR-011 (T11): what the critic knows about the post's images — each image, the network poster it is (name
 * and `use_for`), and the main image of the source page the run read (`null` = the page had none; absent = the page
 * was not read). The critic judges the poster's fit to the topic; lint already blocks the hard cases.
 */
export interface CriticMediaContext {
  images: Array<{ url: string; poster?: { title: string; useFor: string } }>;
  sourceImage?: string | null;
}

/** The context from a spec's media (+ carousel slide backgrounds); null when the post has no image. */
export function criticMediaOf(spec: unknown, sourceImage?: string | null): CriticMediaContext | null {
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
  };
}

/** The «Зображення» block of the critic's user prompt; nothing without images. */
export function criticMediaLines(m: CriticMediaContext | null | undefined): string[] {
  if (!m?.images.length) return [];
  const out = ['', '## Зображення поста'];
  for (const i of m.images) {
    out.push(i.poster ? `- постер мережі «${i.poster.title}», use_for: ${i.poster.useFor}` : `- ${i.url}`);
  }
  if (m.sourceImage) out.push(`Головне зображення сторінки-джерела: ${m.sourceImage}`);
  else if (m.sourceImage === null) out.push('Сторінка-джерело без зображення: новина має йти без media.');
  out.push('Правило: новина (новина, роздача, знижка з джерелом) — лише зображення зі сторінки-джерела; постер мережі — лише на пості без новинного приводу (пояснення, глосарій, добірка), і тема поста має збігатися з use_for. Постер не за темою чи на новині → format_fit ≤ 3.');
  return out;
}
