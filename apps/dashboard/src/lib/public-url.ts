// Spec 026 T3: the public origin baked into index.html (Open Graph and Twitter
// tags need absolute URLs). Read from VITE_PUBLIC_URL at build time by
// vite.config.ts; shared here so node:test covers the rule.

/** Used when VITE_PUBLIC_URL is not set, so a build without it keeps today's link previews. */
export const DEFAULT_PUBLIC_URL = 'https://dev.ai0.global';

/** The placeholder in index.html that the build replaces with the origin (no trailing slash). */
export const PUBLIC_URL_TOKEN = '__AI0_PUBLIC_URL__';

/** `https://example.org/` → `https://example.org`; unset → the default; anything that is not http(s) → an error. */
export function resolvePublicUrl(env: Record<string, string | undefined>): string {
  const raw = env.VITE_PUBLIC_URL?.trim();
  if (!raw) return DEFAULT_PUBLIC_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`VITE_PUBLIC_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`VITE_PUBLIC_URL must be http(s): ${raw}`);
  if (url.search || url.hash) throw new Error(`VITE_PUBLIC_URL must be an origin (and optional path), without ? or #: ${raw}`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Replace every placeholder in the HTML with the resolved origin. */
export function applyPublicUrl(html: string, publicUrl: string): string {
  return html.split(PUBLIC_URL_TOKEN).join(publicUrl);
}
