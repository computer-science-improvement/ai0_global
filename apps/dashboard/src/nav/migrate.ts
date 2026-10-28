// Spec 078 D4: the saved-menu migration, schema v1 → v2.
//
// Why: v2 keeps the v1 shape, but the registry's default menu changed (11 items,
// four groups, the Inbox absorbing the approvals counter). A saved v1 menu lists
// every page in a group or in `hidden`, so without a migration the owner would keep
// the old 26-item menu, the old counters, and the Inbox hidden.
//
// It starts from the v2 default menu and carries over what the owner chose:
// - pins, custom links and per-item overrides (rename, icon, counter off);
// - custom groups (and the order they sat in, relative to the groups that survive);
// - pages the owner hid on purpose: anything hidden that v1 did not hide by default,
//   including every page of a group they hid (the flag on a built-in group is dropped);
// - pages the owner un-hid from v1's default-hidden list (directives, the Telegram
//   tabs…): they stay visible, in their v2 default group;
// - a custom link that sat in a built-in group stays in it when the group survives
//   (Home, Network, Insights, System) and goes to More tools otherwise;
// - the title the owner gave a surviving built-in group (a stored title that is just the
//   v1 built-in title is not a choice, so the group takes its v2 title: Agents → Network).
//
// What it does NOT carry over: the order of pages inside a built-in group, pages
// moved between built-in groups, and the placement of pages the owner left visible
// (the redesign decides which 11 are in the menu; the rest are under More tools).
//
// It runs during render (normalizeNav → every sidebar, palette and constructor),
// so it never throws: every access is guarded and a stored menu of any shape ends
// up as a complete config. Pure; the caller passes the v2 default as `base`.
import { FORCED_IDS, NAV_GROUPS, menuEntries, type NavEntry } from './registry';
import type { NavConfig, NavGroupConfig } from './config';

/**
 * The v1 registry's `hiddenByDefault` pages, frozen: a v1 menu lists them in
 * `hidden` unless the owner showed them, so they say nothing about intent.
 */
export const V1_DEFAULT_HIDDEN: ReadonlyArray<string> = [
  'agents-inbox', 'directives', 'bots', 'telegraph', 'connections-meta', 'connections-tiktok',
  'settings-navigation', 'settings-security', 'settings-ai',
];

/** The v1 registry's built-in group titles, frozen: a stored title equal to one of these is the default, not a rename. */
const V1_GROUP_TITLES: Readonly<Record<string, string>> = {
  g_home: 'Home', g_agents: 'Agents', g_publishing: 'Publishing', g_content: 'Content', g_analytics: 'Analytics',
  g_intelligence: 'Intelligence', g_connections: 'Connections', g_marketing: 'Marketing', g_system: 'System',
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

interface OldGroup { id: string; title?: string; hidden: boolean; items: string[] }

export function migrateV1ToV2(old: unknown, base: NavConfig, registry: ReadonlyArray<NavEntry>): NavConfig {
  const c: Record<string, unknown> = isObj(old) ? old : {};
  const builtin = new Set<string>(NAV_GROUPS.map((g) => g.id));
  const entries = menuEntries(registry);
  const defaultGroupOf = new Map<string, string>(entries.map((e) => [e.id, e.defaultGroup]));

  // The v2 default, copied.
  const groups: NavGroupConfig[] = base.groups.map((g) => ({ ...g, items: [...g.items] }));
  let hidden = [...base.hidden];

  // The v1 groups, once each (the first wins, like normalizeNav).
  const oldGroups: OldGroup[] = [];
  const seenGroup = new Set<string>();
  for (const g of Array.isArray(c.groups) ? c.groups : []) {
    if (!isObj(g) || typeof g.id !== 'string' || seenGroup.has(g.id)) continue;
    seenGroup.add(g.id);
    oldGroups.push({
      id: g.id,
      title: typeof g.title === 'string' && g.title.trim() ? g.title.trim() : undefined,
      hidden: !!g.hidden,
      items: strArr(g.items),
    });
  }

  const custom = (Array.isArray(c.custom) ? c.custom : []).filter(isObj);
  const customIds = new Set<string>(custom.flatMap((x) => (typeof x.id === 'string' ? [x.id] : [])));
  // Pages of the owner's own groups stay where they are.
  const claimed = new Set<string>(oldGroups.filter((g) => !builtin.has(g.id)).flatMap((g) => g.items));

  // Where each id was first placed in v1: a group (hidden or not) or the hidden list.
  const first = new Map<string, { group: string | null; hidden: boolean }>();
  for (const g of oldGroups) for (const id of g.items) if (!first.has(id)) first.set(id, { group: g.id, hidden: g.hidden });
  for (const id of strArr(c.hidden)) if (!first.has(id)) first.set(id, { group: null, hidden: true });

  const hiddenByOwner: string[] = [];
  const unhidden: string[] = [];
  const kept = new Map<string, string[]>();
  for (const [id, f] of first) {
    // Ids that are no longer pages say nothing the menu can keep (normalizeNav warns about the ones in a custom group).
    if (claimed.has(id) || FORCED_IDS.includes(id) || !(defaultGroupOf.has(id) || customIds.has(id))) continue;
    if (f.group !== null && !builtin.has(f.group)) continue;
    if (f.hidden) {
      if (!V1_DEFAULT_HIDDEN.includes(id)) hiddenByOwner.push(id);
    } else if (customIds.has(id)) {
      if (f.group !== null && groups.some((g) => g.id === f.group)) kept.set(f.group, [...(kept.get(f.group) ?? []), id]);
      else hiddenByOwner.push(id);
    } else if (V1_DEFAULT_HIDDEN.includes(id)) {
      unhidden.push(id);
    }
  }

  const drop = new Set<string>([...hiddenByOwner, ...claimed]);
  for (const g of groups) g.items = g.items.filter((id) => !drop.has(id));
  hidden = hidden.filter((id) => !drop.has(id) && !unhidden.includes(id));
  for (const id of hiddenByOwner) if (!hidden.includes(id)) hidden.push(id);
  for (const id of unhidden) {
    if (groups.some((g) => g.items.includes(id))) continue;
    (groups.find((g) => g.id === defaultGroupOf.get(id)) ?? groups[0])?.items.push(id);
  }
  for (const [gid, ids] of kept) groups.find((g) => g.id === gid)?.items.push(...ids);

  // The title the owner gave a built-in group that survives.
  for (const og of oldGroups) {
    const g = builtin.has(og.id) ? groups.find((x) => x.id === og.id) : undefined;
    if (g && og.title && og.title !== V1_GROUP_TITLES[og.id]) g.title = og.title;
  }
  // The owner's groups: before the next group of theirs that survives, or last.
  oldGroups.forEach((og, i) => {
    if (builtin.has(og.id)) return;
    const grp: NavGroupConfig = { id: og.id, ...(og.title ? { title: og.title } : {}), ...(og.hidden ? { hidden: true } : {}), items: og.items };
    const anchor = oldGroups.slice(i + 1).find((x) => groups.some((g) => g.id === x.id));
    groups.splice(anchor ? groups.findIndex((g) => g.id === anchor.id) : groups.length, 0, grp);
  });

  return {
    schemaVersion: 2,
    groups,
    pinned: strArr(c.pinned),
    hidden,
    custom: custom as unknown as NavConfig['custom'],
    overrides: Object.fromEntries(Object.entries(isObj(c.overrides) ? c.overrides : {}).filter(([, v]) => isObj(v))) as NavConfig['overrides'],
  };
}
