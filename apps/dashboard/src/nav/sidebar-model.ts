// Spec 078 D4: the pure parts of the sidebar and the top bar. No React, so node:test covers them.
import type { ResolvedGroup, ResolvedItem, ResolvedNav } from './model';

/**
 * "More tools": the pages that are not in the menu (hidden by default or by the
 * owner), as links. Sub-views (a tab of a bigger page) and pages that no longer
 * exist are left out; custom links come last. Order is the resolved hidden order.
 */
export function moreTools(nav: Pick<ResolvedNav, 'hidden'>): ResolvedItem[] {
  const seen = new Set<string>();
  const ok = nav.hidden.filter((i) => {
    if (i.subview || i.unavailable || seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
  return [...ok.filter((i) => !i.custom), ...ok.filter((i) => i.custom)];
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** The router's location (path plus parsed search), or an href for tests and plain callers. */
export interface LocationLike { pathname: string; search?: Record<string, unknown> }

function asLocation(l: string | LocationLike): { pathname: string; get: (k: string) => string | null } {
  if (typeof l === 'string') {
    const [path, query = ''] = l.split('#', 1)[0].split(/\?(.*)/s, 2);
    const params = new URLSearchParams(query);
    return { pathname: trimSlash(path), get: (k) => params.get(k) };
  }
  const search = l.search ?? {};
  return {
    pathname: trimSlash(l.pathname),
    // The router parses "2" to 2 and "true" to true; item search values are the strings from the URL.
    get: (k) => {
      const v = search[k];
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
    },
  };
}

/**
 * Which menu item the current address belongs to: the longest matching prefix wins
 * (more query keys break a tie), so `/app/agents/inbox` lights Inbox and not Agents,
 * and `/app/agents/some-agent` still lights Agents. `exact` items match their path only.
 * An item with `search` matches only while the address carries those values (like the
 * router's own Link). Items are tried in the order given; the first of equal scores wins.
 * null = none.
 */
export function activeItemId(items: ReadonlyArray<ResolvedItem>, location: string | LocationLike): string | null {
  const here = asLocation(location);
  let best: { id: string; score: number } | null = null;
  for (const item of items) {
    if (item.unavailable) continue;
    const to = trimSlash(item.to);
    const inside = item.exact ? here.pathname === to : here.pathname === to || here.pathname.startsWith(`${to}/`);
    if (!inside) continue;
    const keys = Object.entries(item.search ?? {});
    if (keys.some(([k, v]) => here.get(k) !== v)) continue;
    const score = to.length * 1000 + keys.length;
    if (!best || score > best.score) best = { id: item.id, score };
  }
  return best?.id ?? null;
}

/** Home carries no title when it is the first block (the prototype); a pinned block above it, or a title the owner chose, keeps one. */
export function showGroupTitle(group: Pick<ResolvedGroup, 'id' | 'title'>, index: number, hasPinned: boolean): boolean {
  return !(index === 0 && !hasPinned && group.id === 'g_home' && group.title === 'Home');
}

/** Initials for the operator avatar: two letters of a one-word name, first and last initial otherwise. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1
    ? [...words[0]].slice(0, 2)
    : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join('').toUpperCase();
}

/** The budget the footer card shows: the global row with a daily cap, else any global row (same rule as the map). */
export function pickGlobalBudget<T extends { scopeKind: string; dailyUsd: number | null }>(rows: ReadonlyArray<T> | null | undefined): T | null {
  const list = rows ?? [];
  return list.find((b) => b.scopeKind === 'global' && b.dailyUsd != null) ?? list.find((b) => b.scopeKind === 'global') ?? null;
}

/** Editor channels whose agent is in `live` mode: the "N agents live" pill. */
export function liveAgentCount(channels: ReadonlyArray<{ mode: string }> | null | undefined): number {
  return (channels ?? []).filter((c) => c.mode === 'live').length;
}

export const liveAgentsLabel = (n: number): string => `${n} ${n === 1 ? 'agent' : 'agents'} live`;
