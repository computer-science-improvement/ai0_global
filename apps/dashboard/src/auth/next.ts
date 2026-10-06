/**
 * Where to go after sign-in (spec 028 FR-015). `next` arrives in two shapes:
 *  - router-encoded, from the /app guard: `?next=%2Fapp%2Feditor&reason=…`
 *  - raw, from nginx: `?reason=…&next=/app/editor?tab=inbox` — `next` is last
 *    and is the original `$request_uri`, so it can carry its own `?` and `&`.
 * Only a same-origin `/app` path is accepted (no scheme, no `//`, no backslash,
 * no whitespace); anything else falls back to `/app`. This is the open-redirect
 * guard, so it reads the raw search string, never a pre-parsed object.
 */
export const DEFAULT_NEXT = '/app';

export function parseNext(searchStr: string | null | undefined): string {
  return safeAppPath(extractNext(searchStr ?? '')) ?? DEFAULT_NEXT;
}

function extractNext(searchStr: string): string | null {
  const s = searchStr.startsWith('?') ? searchStr.slice(1) : searchStr;
  const m = /(?:^|&)next=/.exec(s);
  if (!m) return null;
  const rest = s.slice(m.index + m[0].length);
  // nginx form: the raw path runs to the end of the query string.
  if (rest.startsWith('/')) return rest;
  // Router form: one encoded value up to the next parameter.
  const amp = rest.indexOf('&');
  const encoded = amp === -1 ? rest : rest.slice(0, amp);
  let v: string;
  try { v = decodeURIComponent(encoded.replace(/\+/g, '%20')); } catch { return null; }
  // The router JSON-quotes strings that would otherwise parse as JSON.
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { const parsed: unknown = JSON.parse(v); v = typeof parsed === 'string' ? parsed : ''; } catch { return null; }
  }
  return v;
}

/**
 * `/login`'s guard: a browser that is already signed in goes straight to the
 * safe `next` (or `/app`); null = show the login form.
 */
export function loginRedirectTarget(session: { me: unknown } | null | undefined, searchStr: string): string | null {
  return session?.me ? parseNext(searchStr) : null;
}

/** The path itself when it is a same-origin `/app` path, else null. */
export function safeAppPath(p: string | null | undefined): string | null {
  if (!p) return null;
  if (!/^\/app(?:[/?#]|$)/.test(p)) return null;
  if (p.includes('//') || p.includes('\\') || /[\s\u0000-\u001f\u007f]/.test(p)) return null;
  return p;
}
