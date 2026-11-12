const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

export function isLoopbackUri(u: string): boolean {
  const p = parse(u);
  return !!p && p.protocol === 'http:' && LOOPBACK.has(p.hostname);
}

/** What a dynamically registered client (or a CIMD document) may list: Claude's two hosted callbacks or a loopback URL. */
export function isAllowedRedirect(u: string): boolean {
  if (typeof u !== 'string' || u.length > 500) return false;
  const p = parse(u);
  if (!p || p.hash || p.username || p.password) return false;
  if (u === 'https://claude.ai/api/mcp/auth_callback' || u === 'https://claude.com/api/mcp/auth_callback') return true;
  return isLoopbackUri(u);
}

/** Exact string match; for loopback only the port may differ (host, path and query must match). */
export function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  const a = parse(registered), b = parse(given);
  if (!a || !b || !isLoopbackUri(registered) || !isLoopbackUri(given)) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && !b.hash;
}

export const anyRedirectMatches = (registered: readonly string[], given: string): boolean => registered.some((r) => redirectMatches(r, given));
