// Spec 027 FR-012: the ⌘K command palette's entries and matcher. Pure.
import type { IconName } from '../components/ui/Icon';
import { menuEntries, NAV_REGISTRY } from './registry';
import { hrefOf, type ResolvedItem, type ResolvedNav } from './model';

export type PaletteTarget =
  | { type: 'nav'; to: string; search?: Record<string, string>; params?: Record<string, string> }
  | { type: 'action'; action: 'new-post' | 'pin-page' | 'edit-menu' | 'collapse-sidebar' };

export interface PaletteEntry {
  /** Stable key (recents): `page:<id>`, `link:<id>`, `agent:<handle>`, `action:<id>`. */
  key:      string;
  kind:     'page' | 'link' | 'agent' | 'action';
  label:    string;
  /** Second line: the path (duplicate labels after renames stay tellable apart). */
  detail:   string;
  icon:     IconName;
  keywords: string[];
  /** In the registry but not in the menu (hidden by the owner or by default). */
  hidden?:  boolean;
  target:   PaletteTarget;
}

export const PALETTE_ACTIONS: PaletteEntry[] = [
  { key: 'action:new-post', kind: 'action', label: 'New post', detail: 'Compose a scheduled Telegram post', icon: 'plus', keywords: ['create', 'write', 'compose'], target: { type: 'action', action: 'new-post' } },
  { key: 'action:pin-page', kind: 'action', label: 'Pin current page', detail: 'Add this page to Pinned', icon: 'pin', keywords: ['favourite', 'favorite', 'star', 'bookmark'], target: { type: 'action', action: 'pin-page' } },
  { key: 'action:edit-menu', kind: 'action', label: 'Edit menu', detail: 'Settings → Navigation', icon: 'menu', keywords: ['navigation', 'sidebar', 'customize', 'reorder'], target: { type: 'action', action: 'edit-menu' } },
  { key: 'action:collapse-sidebar', kind: 'action', label: 'Collapse sidebar', detail: 'Toggle the narrow menu', icon: 'panel-left', keywords: ['expand', 'toggle', 'rail'], target: { type: 'action', action: 'collapse-sidebar' } },
];

/**
 * Every registry page (with the owner's labels and icons; hidden ones marked),
 * the custom links that still work, the agent handles and the actions.
 */
export function buildPaletteEntries(nav: ResolvedNav, agents: Array<{ handle: string; name: string; emoji?: string | null }> = []): PaletteEntry[] {
  const shown = new Map<string, ResolvedItem & { hiddenInMenu: boolean }>();
  for (const i of [...nav.pinned, ...nav.groups.flatMap((g) => g.items)]) shown.set(i.id, { ...i, hiddenInMenu: false });
  for (const i of nav.hidden) if (!shown.has(i.id)) shown.set(i.id, { ...i, hiddenInMenu: true });

  const out: PaletteEntry[] = [];
  for (const e of menuEntries(NAV_REGISTRY)) {
    const s = shown.get(e.id);
    out.push({
      key: `page:${e.id}`, kind: 'page', label: s?.label ?? e.label, detail: hrefOf(e), icon: s?.icon ?? e.icon,
      keywords: s && s.label !== e.label ? [e.label, ...e.keywords] : e.keywords,
      ...(!s || s.hiddenInMenu ? { hidden: true } : {}),
      target: { type: 'nav', to: e.to, ...(e.search ? { search: e.search } : {}) },
    });
  }
  for (const [id, s] of shown) {
    // A custom link whose page is gone is left out (FR-007).
    if (!s.custom || s.unavailable) continue;
    out.push({
      key: `link:${id}`, kind: 'link', label: s.label, detail: hrefOf(s), icon: s.icon, keywords: ['link'],
      ...(s.hiddenInMenu ? { hidden: true } : {}),
      target: { type: 'nav', to: s.to, ...(s.search ? { search: s.search } : {}) },
    });
  }
  for (const a of agents) {
    out.push({
      key: `agent:${a.handle}`, kind: 'agent', label: `@${a.handle}`, detail: `${a.emoji ? `${a.emoji} ` : ''}${a.name} · agent`, icon: 'agents',
      keywords: [a.name, 'agent'],
      target: { type: 'nav', to: '/app/agents/$handle', params: { handle: a.handle } },
    });
  }
  out.push(...PALETTE_ACTIONS);
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = (s: string) => norm(s).split(/[\s/·@\-_.?=&]+/).filter(Boolean);

/** Characters of `q` in order inside `s`; returns a score (fewer gaps = higher) or -1. */
function subsequence(q: string, s: string): number {
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) { if (last >= 0) gaps += j - last - 1; last = j; i++; }
  }
  return i === q.length ? Math.max(1, 100 - gaps) : -1;
}

/** How well `query` matches an entry (0 = no match). Label beats keywords beats path. */
export function scoreEntry(query: string, e: PaletteEntry): number {
  const q = norm(query.trim());
  if (!q) return 1;
  const label = norm(e.label);
  const lw = words(e.label);
  const short = 50 - Math.min(label.length, 50); // shorter labels win ties
  let s = 0;
  if (label === q) s = 1000;
  else if (label.startsWith(q)) s = 900 + short;
  else if (lw.some((w) => w.startsWith(q))) s = 800 + short;
  else if (lw.length > 1 && lw.map((w) => w[0]).join('').startsWith(q)) s = 750 + short;
  else if (e.keywords.some((k) => norm(k).startsWith(q) || words(k).some((w) => w.startsWith(q)))) s = 600 + short;
  else if (label.includes(q)) s = 500 + short;
  else if (words(e.detail).some((w) => w.startsWith(q))) s = 450;
  else if (norm(e.detail).includes(q)) s = 400;
  else {
    const sub = subsequence(q, label);
    if (sub > 0) s = 200 + sub;
    else {
      const k = Math.max(...e.keywords.map((x) => subsequence(q, norm(x))), -1);
      if (k > 0) s = 100 + k / 2;
    }
  }
  if (!s) return 0;
  // Pages first, then links, agents and actions; hidden pages just below visible ones.
  const kind = e.kind === 'page' ? 4 : e.kind === 'link' ? 3 : e.kind === 'agent' ? 1 : 2;
  return s + kind - (e.hidden ? 2 : 0);
}

/**
 * Ranked matches. With no query: the last picks first (up to 5), then the rest
 * in menu order. With a query: by score; a recent pick gets a small boost.
 */
export function searchPalette(entries: PaletteEntry[], query: string, recent: string[] = [], limit = 50): PaletteEntry[] {
  const rank = new Map(recent.map((k, i) => [k, i]));
  if (!query.trim()) {
    const first = recent.map((k) => entries.find((e) => e.key === k)).filter((e): e is PaletteEntry => !!e);
    const rest = entries.filter((e) => !rank.has(e.key) && e.kind !== 'agent');
    return [...first, ...rest].slice(0, limit);
  }
  return entries
    .map((e, i) => ({ e, i, s: scoreEntry(query, e) }))
    .filter((x) => x.s > 0)
    .map((x) => ({ ...x, s: x.s + (rank.has(x.e.key) ? 30 - rank.get(x.e.key)! * 5 : 0) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

export const RECENT_KEY = 'dashboard:palette-recent';
const RECENT_MAX = 5;

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function pushRecent(key: string): string[] {
  const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage off */ }
  return next;
}

/** FR-012: the shortcut is ignored while typing in a field. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const t = el as HTMLElement;
  const tag = t.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = ((t as HTMLInputElement).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return t.isContentEditable === true || t.getAttribute?.('contenteditable') === 'true';
}
