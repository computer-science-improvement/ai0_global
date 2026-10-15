/**
 * Spec 037 FR-011 (T11): one image URL in a comparable form, so the source page's main image and the post's media
 * match despite noise. Kept simple on purpose:
 *   • scheme ignored (http = https), host lower-cased without `www.` and the default port, fragment dropped;
 *   • query parameters that only track or resize are dropped (`utm_*`, `w` / `h` / `width` / `height` / `size` /
 *     `resize` / `fit` / `crop` / `quality` / `q` / `auto` / `fm` / `format` / `dpr`, `ixlib` / `ixid`, cache
 *     busters `v` / `ver` / `cb` …); the others stay, sorted;
 *   • the path is kept as is (a size baked into the file name, `hero-1200x630.jpg`, is a different image).
 * Not a URL → trimmed and lower-cased.
 */
const NOISE_PARAM = /^(?:utm_[\w-]+|w|h|width|height|size|resize|fit|crop|quality|q|auto|fm|format|dpr|ixlib|ixid|s|v|ver|version|cb|cache|_|fbclid|gclid|ref)$/i;

export function normalizeImageUrl(url: string): string {
  const raw = url.trim();
  let u: URL;
  try { u = new URL(raw); } catch { return raw.toLowerCase(); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  const params = [...u.searchParams.entries()].filter(([k]) => !NOISE_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = u.pathname.replace(/\/+$/, '') || '';
  return `${host}${port}${path}${query}`;
}

/** Whether two image URLs name the same image (see normalizeImageUrl). */
export function sameImage(a: string, b: string): boolean {
  return normalizeImageUrl(a) === normalizeImageUrl(b);
}
