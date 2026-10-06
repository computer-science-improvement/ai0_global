// Spec 027 FR-007: does a path still match a route? Pure: the patterns come from
// the router at runtime (`Object.keys(router.routesByPath)`) and from
// routeTree.gen.ts in tests.

/** Path part of an href, without query/hash and trailing slash ('/' stays). */
export function pathOf(href: string): string {
  const p = href.split(/[?#]/, 1)[0] || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function segments(path: string): string[] {
  return pathOf(path).split('/').filter(Boolean);
}

/** A matcher over route patterns such as `/app/agents/$handle` (a bare `$` is a splat). */
export function makeRouteMatcher(patterns: Iterable<string>): (href: string) => boolean {
  const compiled = [...new Set([...patterns].map(pathOf))].map(segments);
  return (href: string) => {
    let segs: string[];
    try { segs = segments(href).map((s) => decodeURIComponent(s)); } catch { return false; }
    return compiled.some((pat) => {
      for (let i = 0; i < pat.length; i++) {
        const p = pat[i];
        if (p === '$') return true;
        const s = segs[i];
        if (s === undefined) return false;
        if (p.startsWith('$')) continue;
        if (p !== s) return false;
      }
      return pat.length === segs.length;
    });
  };
}

/** The full paths a generated routeTree.gen.ts declares (FileRoutesByFullPath). */
export function fullPathsFromRouteTree(source: string): string[] {
  const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
}
