// Spec 027 FR-006: saved menu + registry → the menu every surface renders.
// Pure (no React, no router): `routeExists` and `isIcon` are injected.
//
//   resolveNav = renderNav(normalizeNav(...))
//
// normalizeNav turns whatever is stored (nothing, an older or newer schema,
// garbage, ids that no longer exist) into a complete v1 config: every menu
// candidate is placed exactly once (in a group or in `hidden`), unknown ids are
// parked in `hidden` (listed as Unavailable, never rendered), duplicates keep
// the first. The constructor edits that normalized config as its draft.
// renderNav applies overrides, drops empty/hidden groups, forces Overview and
// Settings visible and marks custom links whose route is gone.
import type { IconName } from '../components/ui/Icon';
import { NAV_GROUPS, NAV_REGISTRY, FORCED_IDS, menuEntries, type NavEntry } from './registry';
import { NAV_SCHEMA_VERSION, type CustomLink, type NavConfigV1, type NavGroupConfig } from './config';
import { itemFromEntry, type ResolvedItem, type ResolvedNav } from './model';

/** Schema migrations: `MIGRATIONS[v]` turns a v config into a v+1 config. None yet (v1 is the first). */
export const MIGRATIONS: Record<number, (c: any) => any> = {};

export interface ResolveOptions {
  /** Does an href still match a route? (FR-007) Default: everything matches. */
  routeExists?: (href: string) => boolean;
  /** Is this a known icon name? Unknown override/custom icons fall back. Default: yes. */
  isIcon?: (name: string) => boolean;
  /** For tests: the schema this build understands and its migration chain. */
  currentVersion?: number;
  migrations?: Record<number, (c: any) => any>;
}

export interface NormalizedNav {
  config:   NavConfigV1;
  /** Where the config came from. 'newer' = written by a newer build: shown as default, saving blocked. */
  source:   'default' | 'saved' | 'newer' | 'invalid';
  /** Registry items placed automatically since the last save (FR-006 "new"). */
  newIds:   Set<string>;
  /** Ids in the config that are neither registry pages nor custom links. */
  unknownIds: Set<string>;
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The FR-003 default menu as a v1 config. */
export function defaultConfig(registry: ReadonlyArray<NavEntry> = NAV_REGISTRY): NavConfigV1 {
  const entries = menuEntries(registry);
  return {
    schemaVersion: 1,
    groups: NAV_GROUPS.map((g) => ({ id: g.id, items: entries.filter((e) => e.defaultGroup === g.id && !e.hiddenByDefault).map((e) => e.id) })),
    pinned: [],
    hidden: entries.filter((e) => e.hiddenByDefault).map((e) => e.id),
    custom: [],
    overrides: {},
  };
}

function cleanCustom(raw: unknown): CustomLink[] {
  const seen = new Set<string>();
  const out: CustomLink[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.to !== 'string' || seen.has(c.id)) continue;
    seen.add(c.id);
    const search = isObj(c.search)
      ? Object.fromEntries(Object.entries(c.search).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : undefined;
    out.push({
      id: c.id, to: c.to,
      label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : c.to,
      icon: typeof c.icon === 'string' ? c.icon : 'globe',
      ...(search && Object.keys(search).length ? { search } : {}),
    });
  }
  return out;
}

export function normalizeNav(
  registry: ReadonlyArray<NavEntry>,
  stored: unknown,
  opts: ResolveOptions = {},
): NormalizedNav {
  const current = opts.currentVersion ?? NAV_SCHEMA_VERSION;
  const migrations = opts.migrations ?? MIGRATIONS;
  const warnings: string[] = [];
  const fallback = (source: NormalizedNav['source']): NormalizedNav =>
    ({ config: defaultConfig(registry), source, newIds: new Set(), unknownIds: new Set(), warnings });

  if (stored == null) return fallback('default');
  if (!isObj(stored) || typeof stored.schemaVersion !== 'number' || !Number.isInteger(stored.schemaVersion) || stored.schemaVersion < 1) {
    warnings.push('The saved menu is unreadable; showing the default menu.');
    return fallback('invalid');
  }
  if (stored.schemaVersion > current) {
    warnings.push('The saved menu was made by a newer version of the dashboard; reload the page to see it. Saving is blocked so it is not overwritten.');
    return fallback('newer');
  }
  let cfg: Record<string, any> = stored;
  for (let v = cfg.schemaVersion; v < current; v++) {
    const step = migrations[v];
    if (!step) { warnings.push(`No migration from menu schema v${v}; showing the default menu.`); return fallback('invalid'); }
    cfg = step(cfg);
  }

  const entries = menuEntries(registry);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const custom = cleanCustom(cfg.custom);
  const customIds = new Set(custom.map((c) => c.id));
  const known = (id: string) => byId.has(id) || customIds.has(id);

  const placed = new Set<string>();
  const unknownIds = new Set<string>();
  const hidden: string[] = [];
  const take = (id: string, where: string): boolean => {
    if (placed.has(id)) { warnings.push(`"${id}" appears twice (${where}); keeping the first.`); return false; }
    placed.add(id);
    if (!known(id)) { unknownIds.add(id); warnings.push(`"${id}" is no longer a page; skipped.`); hidden.push(id); return false; }
    return true;
  };

  const groups: NavGroupConfig[] = [];
  const groupIds = new Set<string>();
  const builtinTitle = new Map(NAV_GROUPS.map((g) => [g.id as string, g.title]));
  for (const g of Array.isArray(cfg.groups) ? cfg.groups : []) {
    if (!isObj(g) || typeof g.id !== 'string' || groupIds.has(g.id)) continue;
    groupIds.add(g.id);
    const items = strArr(g.items).filter((id) => take(id, `group ${g.id}`));
    const title = typeof g.title === 'string' && g.title.trim() ? g.title.trim() : undefined;
    groups.push({ id: g.id, ...(title ? { title } : builtinTitle.has(g.id) ? {} : { title: 'Group' }), ...(g.hidden ? { hidden: true } : {}), items });
  }
  for (const id of strArr(cfg.hidden)) if (take(id, 'hidden')) hidden.push(id);

  // Pinned: known ids, once each, at most 10.
  const pinned: string[] = [];
  for (const id of strArr(cfg.pinned)) {
    if (pinned.includes(id)) continue;
    if (!known(id)) { unknownIds.add(id); continue; }
    if (pinned.length < 10) pinned.push(id);
  }

  // Registry pages found nowhere: new since the save. Menu pages go to their
  // default group (or Home, or a recreated default group); hidden-by-default ones to `hidden`.
  const newIds = new Set<string>();
  for (const e of entries) {
    if (placed.has(e.id)) continue;
    placed.add(e.id);
    if (e.hiddenByDefault) { hidden.push(e.id); continue; }
    newIds.add(e.id);
    let target = groups.find((g) => g.id === e.defaultGroup) ?? groups.find((g) => g.id === 'g_home');
    if (!target) { target = { id: e.defaultGroup, items: [] }; groups.push(target); }
    target.items.push(e.id);
  }
  // Custom links found nowhere stay available from Hidden.
  for (const c of custom) if (!placed.has(c.id)) { placed.add(c.id); hidden.push(c.id); }

  const overrides: NavConfigV1['overrides'] = {};
  if (isObj(cfg.overrides)) {
    for (const [id, o] of Object.entries(cfg.overrides)) {
      if (!isObj(o) || !byId.has(id)) continue;
      const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined;
      const icon = typeof o.icon === 'string' ? o.icon : undefined;
      const badge = typeof o.badge === 'boolean' ? o.badge : undefined;
      if (label || icon || badge !== undefined) overrides[id] = { ...(label ? { label } : {}), ...(icon ? { icon } : {}), ...(badge !== undefined ? { badge } : {}) };
    }
  }

  return {
    config: { schemaVersion: 1, groups, pinned, hidden, custom, overrides },
    source: 'saved', newIds, unknownIds, warnings,
  };
}

export function renderNav(
  registry: ReadonlyArray<NavEntry>,
  n: NormalizedNav,
  opts: ResolveOptions = {},
): ResolvedNav {
  const routeExists = opts.routeExists ?? (() => true);
  const isIcon = opts.isIcon ?? (() => true);
  const cfg = n.config;
  const byId = new Map(menuEntries(registry).map((e) => [e.id, e]));
  const customById = new Map(cfg.custom.map((c) => [c.id, c]));
  const builtinTitle = new Map(NAV_GROUPS.map((g) => [g.id as string, g.title]));
  const warnings = [...n.warnings];
  const unavailable: ResolvedNav['unavailable'] = [...n.unknownIds].map((id) => ({ id, label: id, reason: 'removed' as const }));

  const item = (id: string): ResolvedItem | null => {
    const e = byId.get(id);
    if (e) {
      const o = cfg.overrides[id] ?? {};
      return {
        ...itemFromEntry(e),
        ...(o.label ? { label: o.label } : {}),
        ...(o.icon && isIcon(o.icon) ? { icon: o.icon as IconName } : {}),
        badge: o.badge === false ? null : e.badge ?? null,
        ...(n.newIds.has(id) ? { isNew: true } : {}),
      };
    }
    const c = customById.get(id);
    if (!c) return null;
    const ok = routeExists(c.to);
    return {
      id: c.id, to: c.to, search: c.search, label: c.label,
      icon: (isIcon(c.icon) ? c.icon : 'globe') as IconName,
      badge: null, custom: true, ...(ok ? {} : { unavailable: true }),
    };
  };
  for (const c of cfg.custom) {
    if (!routeExists(c.to)) unavailable.push({ id: c.id, label: c.label, reason: 'no-route' });
  }

  const groups = cfg.groups.map((g) => ({
    id: g.id,
    title: g.title ?? builtinTitle.get(g.id) ?? 'Group',
    ...(builtinTitle.has(g.id) ? {} : { custom: true }),
    hidden: !!g.hidden,
    items: g.items.map(item).filter((x): x is ResolvedItem => !!x),
  }));
  const hidden: ResolvedItem[] = [];
  for (const g of groups) if (g.hidden) hidden.push(...g.items.filter((i) => !i.forced));
  for (const id of cfg.hidden) { const it = item(id); if (it && !it.forced) hidden.push(it); }

  // Overview and Settings are always visible (the safety net that keeps the constructor reachable).
  for (const id of FORCED_IDS) {
    const visible = groups.some((g) => !g.hidden && g.items.some((i) => i.id === id));
    if (visible) continue;
    const it = item(id);
    if (!it) continue;
    for (const g of groups) g.items = g.items.filter((i) => i.id !== id);
    const entry = byId.get(id)!;
    let target = groups.find((g) => g.id === entry.defaultGroup && !g.hidden);
    if (!target) {
      const visibleGroups = groups.filter((g) => !g.hidden);
      target = id === 'overview' ? visibleGroups[0] : visibleGroups[visibleGroups.length - 1];
    }
    if (!target) {
      target = { id: entry.defaultGroup, title: builtinTitle.get(entry.defaultGroup) ?? 'Home', hidden: false, items: [] };
      if (id === 'overview') groups.unshift(target); else groups.push(target);
    }
    if (id === 'overview') target.items.unshift(it); else target.items.push(it);
    warnings.push(`${it.label} is always shown.`);
  }

  const pinned = cfg.pinned.map(item).filter((x): x is ResolvedItem => !!x && !x.unavailable);

  return {
    pinned,
    groups: groups.filter((g) => !g.hidden && g.items.length > 0).map(({ hidden: _h, ...g }) => g),
    hidden,
    unavailable,
    warnings,
  };
}

/** FR-006: the menu to render for a stored config (null = default). */
export function resolveNav(
  registry: ReadonlyArray<NavEntry>,
  stored: unknown,
  opts: ResolveOptions = {},
): ResolvedNav & { source: NormalizedNav['source'] } {
  const n = normalizeNav(registry, stored, opts);
  return { ...renderNav(registry, n, opts), source: n.source };
}
