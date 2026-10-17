/**
 * Database-name helpers for the PG tests that create their own throwaway
 * database next to EDITOR_PG_TEST_URL. `new URL()` rejects socket-style URLs
 * such as `postgresql://postgres@/db?host=/tmp/x&port=5432` (user info with an
 * empty host), which pg itself accepts, so the URL is split as a string:
 * scheme + authority, then the path (the database), then query and hash.
 */
const PG_URL = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(\/[^?#]*)?(.*)$/i;

function split(url: string): { base: string; path: string; rest: string } {
  const m = PG_URL.exec(url);
  if (!m) throw new Error(`not a postgres connection URL: ${url}`);
  return { base: m[1], path: m[2] ?? '', rest: m[3] };
}

/** The database the URL points at, or 'postgres' when it names none. */
export function pgDbName(url: string): string {
  return decodeURIComponent(split(url).path.slice(1)) || 'postgres';
}

/** The same connection (user, host or socket, port, options) pointed at another database. */
export function pgWithDb(url: string, db: string): string {
  const { base, rest } = split(url);
  return `${base}/${encodeURIComponent(db)}${rest}`;
}
