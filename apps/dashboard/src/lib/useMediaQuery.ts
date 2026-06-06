import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Returns whether it currently matches and
 * re-renders on change. SSR-safe (returns false until mounted in a browser).
 *
 * Used to drive the responsive shell — the dashboard's layout is inline-style
 * driven, so JS (not CSS media queries) decides desktop-static vs mobile-drawer
 * sidebar. Inline styles would otherwise win over any @media rule.
 */
export function useMediaQuery(query: string): boolean {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;

  const [matches, setMatches] = useState<boolean>(get);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    handler();
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
