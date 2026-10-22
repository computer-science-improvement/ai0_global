/**
 * Spec 062 FR-004: a media URL a model made up. In chat e8c11647 `lint_post` was run on a spec whose picture was
 * `cdn.prompthero.com/placeholder.jpg` and its result was reported as the draft's re-lint. Hosts `example.*` and a path
 * segment or file name `placeholder` / `example` are never a real picture; the tool refuses them by name.
 */

const EXAMPLE_HOST_RE = /(?:^|\.)example(?:\.|$)/i;
const MADE_UP_NAME_RE = /(?:^|[-_.])(?:placeholder|example)(?:[-_.\d]|$)/i;

export function isMadeUpMediaUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (EXAMPLE_HOST_RE.test(u.hostname)) return true;
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
  return path.split('/').some((seg) => seg && MADE_UP_NAME_RE.test(seg.replace(/\.[a-z0-9]{2,5}$/i, '')));
}

/** The made-up picture URLs of a spec (`media[].url`, a slide `image`); empty when it has none. */
export function madeUpMediaUrls(spec: unknown): string[] {
  const s = (spec ?? {}) as { media?: unknown; slides?: unknown };
  const urls: unknown[] = [
    ...(Array.isArray(s.media) ? s.media.map((m) => (m as { url?: unknown })?.url) : []),
    ...(Array.isArray(s.slides) ? s.slides.map((m) => (m as { image?: unknown })?.image) : []),
  ];
  return urls.filter((u): u is string => typeof u === 'string' && isMadeUpMediaUrl(u));
}

/** The tool error for a spec with made-up picture URLs, or null. */
export function madeUpMediaError(spec: unknown): { error: 'invalid_media_url'; details: string } | null {
  const bad = madeUpMediaUrls(spec);
  return bad.length
    ? { error: 'invalid_media_url', details: `${bad.slice(0, 3).join(', ')} — виглядає вигаданим (example.* чи placeholder/example у шляху). Візьми зображення з джерела (extract_images, og_image) або публікуй без нього.` }
    : null;
}
