// Spec 027: the resolved menu every navigation surface renders. Pure (no React).
import type { IconName } from '../components/ui/Icon';
import { NAV_GROUPS, NAV_REGISTRY, FORCED_IDS, menuEntries, type BadgeKey, type NavEntry } from './registry';

export interface ResolvedItem {
  id:       string;
  to:       string;
  search?:  Record<string, string>;
  label:    string;
  icon:     IconName;
  exact?:   boolean;
  /** The counter this item shows; null when the owner turned its badge off. */
  badge:    BadgeKey | null;
  /** A custom link (FR-007). */
  custom?:  boolean;
  /** Auto-appended since the menu was last saved (FR-006): shows a "new" dot. */
  isNew?:   boolean;
  /** A custom link whose target no longer matches a route: rendered disabled. */
  unavailable?: boolean;
  /** Overview and Settings: always visible. */
  forced?:  boolean;
}

export interface ResolvedGroup {
  id:     string;
  title:  string;
  custom?: boolean;
  items:  ResolvedItem[];
}

export interface ResolvedNav {
  pinned:  ResolvedItem[];
  groups:  ResolvedGroup[];
  /** Menu candidates the owner hid (or hidden by default): still routable, listed in ⌘K. */
  hidden:  ResolvedItem[];
  /** Saved ids that no longer exist, and custom links whose route is gone. */
  unavailable: Array<{ id: string; label: string; reason: 'removed' | 'no-route' }>;
  warnings: string[];
}

export function itemFromEntry(e: NavEntry): ResolvedItem {
  return {
    id: e.id, to: e.to, search: e.search, label: e.label, icon: e.icon, exact: e.exact,
    badge: e.badge ?? null,
    forced: FORCED_IDS.includes(e.id) || undefined,
  };
}

/** The FR-003 default menu (schema v1): no saved config. */
export function defaultNav(registry: ReadonlyArray<NavEntry> = NAV_REGISTRY): ResolvedNav {
  const entries = menuEntries(registry);
  return {
    pinned: [],
    groups: NAV_GROUPS.map((g) => ({
      id: g.id, title: g.title,
      items: entries.filter((e) => e.defaultGroup === g.id && !e.hiddenByDefault).map(itemFromEntry),
    })).filter((g) => g.items.length > 0),
    hidden: entries.filter((e) => e.hiddenByDefault).map(itemFromEntry),
    unavailable: [],
    warnings: [],
  };
}

/** `to` + `search` as one href (for display, recents and the "current page" capture). */
export function hrefOf(item: { to: string; search?: Record<string, string> }): string {
  const qs = item.search ? new URLSearchParams(item.search).toString() : '';
  return qs ? `${item.to}?${qs}` : item.to;
}

/**
 * Stored search params are strings (they come from a URL). The router parses a
 * URL's values as JSON when they look like JSON ("2" → 2, "true" → true), so a
 * link must hand it the same typed values; otherwise "2" would be written as
 * `%222%22` and a route expecting a number would get a string.
 */
export function routerSearch(search?: Record<string, string>): Record<string, unknown> | undefined {
  if (!search) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(search)) {
    // Same rule as the router's parser: JSON when it parses ('2' → 2, '"x"' → 'x'), else the raw string.
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return out;
}
