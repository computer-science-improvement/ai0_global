// Spec 027: edits on a normalized menu config (the constructor draft and the
// sidebar quick actions). Pure and immutable: every op returns a new config.
import { FORCED_IDS } from './registry';
import { NAV_LIMITS, type CustomLink, type NavConfigV1, type NavOverride } from './config';

const clone = (c: NavConfigV1): NavConfigV1 => ({
  ...c,
  groups: c.groups.map((g) => ({ ...g, items: [...g.items] })),
  pinned: [...c.pinned],
  hidden: [...c.hidden],
  custom: c.custom.map((x) => ({ ...x })),
  overrides: Object.fromEntries(Object.entries(c.overrides).map(([k, v]) => [k, { ...v }])),
});

const without = (c: NavConfigV1, id: string) => {
  for (const g of c.groups) g.items = g.items.filter((x) => x !== id);
  c.hidden = c.hidden.filter((x) => x !== id);
};

export function isPinned(c: NavConfigV1, id: string): boolean {
  return c.pinned.includes(id);
}

/** Pin or unpin. Pinning past the limit is a no-op (the caller explains). */
export function togglePin(c: NavConfigV1, id: string): NavConfigV1 {
  const n = clone(c);
  if (n.pinned.includes(id)) n.pinned = n.pinned.filter((x) => x !== id);
  else if (n.pinned.length < NAV_LIMITS.pinned) n.pinned.push(id);
  return n;
}

export function canHide(id: string): boolean {
  return !FORCED_IDS.includes(id);
}

/** Hide an item (it stays routable and in ⌘K). Overview and Settings cannot be hidden. */
export function hideItem(c: NavConfigV1, id: string): NavConfigV1 {
  if (!canHide(id)) return c;
  const n = clone(c);
  without(n, id);
  n.hidden.push(id);
  n.pinned = n.pinned.filter((x) => x !== id);
  return n;
}

/** Show a hidden item at the end of `groupId` (or the first group). */
export function showItem(c: NavConfigV1, id: string, groupId?: string): NavConfigV1 {
  const n = clone(c);
  without(n, id);
  const g = n.groups.find((x) => x.id === groupId) ?? n.groups.find((x) => !x.hidden) ?? n.groups[0];
  if (g) g.items.push(id);
  else n.groups.push({ id: 'g_home', items: [id] });
  return n;
}

/** Move an item into `groupId` so it ends up at `index` there (clamped). Also un-hides it. */
export function moveItem(c: NavConfigV1, id: string, groupId: string, index: number): NavConfigV1 {
  const n = clone(c);
  const target = n.groups.find((g) => g.id === groupId);
  if (!target) return c;
  without(n, id);
  target.items.splice(Math.max(0, Math.min(index, target.items.length)), 0, id);
  return n;
}

/** Drag and drop: put `id` before `beforeId` in `groupId` (null = at the end). */
export function moveItemBefore(c: NavConfigV1, id: string, groupId: string, beforeId: string | null): NavConfigV1 {
  if (id === beforeId) return c;
  const target = c.groups.find((g) => g.id === groupId);
  if (!target) return c;
  const rest = target.items.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  return moveItem(c, id, groupId, at < 0 ? rest.length : at);
}

/** ↑/↓ inside a group; at the edge it hops into the neighbouring visible group. */
export function nudgeItem(c: NavConfigV1, id: string, dir: -1 | 1): NavConfigV1 {
  const gi = c.groups.findIndex((g) => g.items.includes(id));
  if (gi < 0) return c;
  const g = c.groups[gi];
  const i = g.items.indexOf(id);
  const j = i + dir;
  if (j >= 0 && j < g.items.length) {
    const n = clone(c);
    const items = n.groups[gi].items;
    [items[i], items[j]] = [items[j], items[i]];
    return n;
  }
  const next = c.groups[gi + dir];
  return next ? moveItem(c, id, next.id, dir < 0 ? next.items.length : 0) : c;
}

export function moveGroup(c: NavConfigV1, groupId: string, index: number): NavConfigV1 {
  const n = clone(c);
  const i = n.groups.findIndex((g) => g.id === groupId);
  if (i < 0) return c;
  const [g] = n.groups.splice(i, 1);
  n.groups.splice(Math.max(0, Math.min(index, n.groups.length)), 0, g);
  return n;
}

export function nudgeGroup(c: NavConfigV1, groupId: string, dir: -1 | 1): NavConfigV1 {
  const i = c.groups.findIndex((g) => g.id === groupId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= c.groups.length) return c;
  return moveGroup(c, groupId, j);
}

export function setGroupHidden(c: NavConfigV1, groupId: string, hidden: boolean): NavConfigV1 {
  const n = clone(c);
  n.groups = n.groups.map((g) => (g.id === groupId ? { ...g, ...(hidden ? { hidden: true } : { hidden: undefined }) } : g));
  for (const g of n.groups) if (!g.hidden) delete g.hidden;
  return n;
}

export function renameGroup(c: NavConfigV1, groupId: string, title: string): NavConfigV1 {
  const n = clone(c);
  const g = n.groups.find((x) => x.id === groupId);
  if (!g) return c;
  const t = title.trim().slice(0, NAV_LIMITS.label);
  if (t) g.title = t;
  else delete g.title;
  return n;
}

export function addGroup(c: NavConfigV1, id: string, title: string): NavConfigV1 {
  if (c.groups.length >= NAV_LIMITS.groups) return c;
  const n = clone(c);
  n.groups.push({ id, title: title.trim().slice(0, NAV_LIMITS.label) || 'New group', items: [] });
  return n;
}

/** Delete a custom group; its items go to Hidden (built-in groups can only be hidden). */
export function deleteGroup(c: NavConfigV1, groupId: string): NavConfigV1 {
  if (!groupId.startsWith('g_c_')) return c;
  const n = clone(c);
  const g = n.groups.find((x) => x.id === groupId);
  if (!g) return c;
  n.groups = n.groups.filter((x) => x.id !== groupId);
  n.hidden.push(...g.items.filter((id) => !n.hidden.includes(id)));
  // Overview/Settings in a deleted group go back to the first group instead.
  for (const id of FORCED_IDS) {
    if (n.hidden.includes(id)) { n.hidden = n.hidden.filter((x) => x !== id); (n.groups[0] ?? (n.groups[0] = { id: 'g_home', items: [] })).items.push(id); }
  }
  return n;
}

/** Rename / re-icon / badge toggle. An empty label means "back to the default". */
export function setOverride(c: NavConfigV1, id: string, patch: NavOverride): NavConfigV1 {
  const n = clone(c);
  const custom = n.custom.find((x) => x.id === id);
  if (custom) {
    if (patch.label !== undefined && patch.label.trim()) custom.label = patch.label.trim().slice(0, NAV_LIMITS.label);
    if (patch.icon) custom.icon = patch.icon;
    return n;
  }
  const o: NavOverride = { ...(n.overrides[id] ?? {}) };
  if (patch.label !== undefined) {
    const l = patch.label.trim().slice(0, NAV_LIMITS.label);
    if (l) o.label = l; else delete o.label;
  }
  if (patch.icon !== undefined) { if (patch.icon) o.icon = patch.icon; else delete o.icon; }
  if (patch.badge !== undefined) { if (patch.badge) delete o.badge; else o.badge = false; }
  if (Object.keys(o).length) n.overrides[id] = o; else delete n.overrides[id];
  return n;
}

/** Add a custom link at the end of `groupId` (or the first group); `null` = not in a group (Hidden), e.g. pin-only. */
export function addCustomLink(c: NavConfigV1, link: CustomLink, groupId?: string | null): NavConfigV1 {
  if (c.custom.length >= NAV_LIMITS.custom) return c;
  const n = clone(c);
  n.custom.push({ ...link, label: link.label.trim().slice(0, NAV_LIMITS.label) || link.to });
  if (groupId === null) { n.hidden.push(link.id); return n; }
  const g = n.groups.find((x) => x.id === groupId) ?? n.groups.find((x) => !x.hidden) ?? n.groups[0];
  if (g) g.items.push(link.id); else n.hidden.push(link.id);
  return n;
}

/** Remove for good: a custom link, or an unavailable (unknown) id parked in Hidden. */
export function removeRef(c: NavConfigV1, id: string): NavConfigV1 {
  const n = clone(c);
  without(n, id);
  n.pinned = n.pinned.filter((x) => x !== id);
  n.custom = n.custom.filter((x) => x.id !== id);
  delete n.overrides[id];
  return n;
}

/**
 * ⌘K "Pin current page": pin the registry page at exactly this address, or an
 * existing custom link to it, or a new pin-only custom link. Same object when
 * nothing changes (already pinned, or the 10-pin limit).
 */
export function pinPage(c: NavConfigV1, target: { to: string; search?: Record<string, string> }, label: string, registryId: string | null, newId: string): NavConfigV1 {
  const href = (t: { to: string; search?: Record<string, string> }) => {
    const qs = t.search ? new URLSearchParams(t.search).toString() : '';
    return qs ? `${t.to}?${qs}` : t.to;
  };
  const id = registryId ?? c.custom.find((x) => href(x) === href(target))?.id;
  if (id) return c.pinned.includes(id) || c.pinned.length >= NAV_LIMITS.pinned ? c : togglePin(c, id);
  if (c.pinned.length >= NAV_LIMITS.pinned || c.custom.length >= NAV_LIMITS.custom) return c;
  return togglePin(addCustomLink(c, { id: newId, label, icon: 'link', ...target }, null), newId);
}

/** Total item references (the server allows 150). */
export function refCount(c: NavConfigV1): number {
  return c.groups.reduce((s, g) => s + g.items.length, 0) + c.pinned.length + c.hidden.length;
}
