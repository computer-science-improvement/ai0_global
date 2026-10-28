// Spec 078 B2: the pure part of the Inbox page (`routes/app.agents_.inbox.tsx`): what the URL means, which notes a tab
// shows, how repeats of one problem collapse into one row, which note is selected, and the copy of the empty states.
// No React and no api imports, so it is tested with node:test.
//
// Search params: `{ tab, unread, note }`.
//   tab     to-approve | all | critical | action | fyi, plus the legacy `unread` (the old Unread tab)
//   unread  the "Unread only" switch; on unless the URL says `unread=false`
//   note    the selected note id (a deep link); new in spec 078
// Legacy links keep working: `?tab=unread` is All with Unread only on, `?tab=all` is All with Unread only OFF (what the
// old All tab showed), `?tab=approvals` is To approve. A bare URL is decided from the data (`autoView`).

export type Severity = 'info' | 'action' | 'critical';

export type InboxTab = 'approvals' | 'all' | 'critical' | 'action' | 'fyi';
export const INBOX_TABS: readonly InboxTab[] = ['approvals', 'all', 'critical', 'action', 'fyi'];

/** What the URL may carry for `tab`: a tab, or the old Unread tab. */
export type InboxTabParam = InboxTab | 'unread';

export interface InboxSearch {
  tab?:    InboxTabParam;
  unread?: boolean;
  note?:   number;
}

const asBool = (v: unknown): boolean | undefined => {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return undefined;
};

const asId = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** `validateSearch` of the route: anything unknown is dropped, nothing throws. */
export function parseInboxSearch(s: Record<string, unknown>): InboxSearch {
  const tab = typeof s.tab === 'string' && (s.tab === 'unread' || (INBOX_TABS as readonly string[]).includes(s.tab)) ? (s.tab as InboxTabParam) : undefined;
  const unread = asBool(s.unread);
  const note = asId(s.note);
  return { ...(tab ? { tab } : {}), ...(unread !== undefined ? { unread } : {}), ...(note !== undefined ? { note } : {}) };
}

/** The URL read as a view. `null` = "not in the URL": the page decides it from the data (`autoView`). */
export interface ResolvedView {
  tab:    InboxTab | null;
  unread: boolean | null;
  note:   number | null;
}

export function resolveView(s: InboxSearch): ResolvedView {
  const note = s.note ?? null;
  if (s.tab === 'unread') return { tab: 'all', unread: true, note };
  // `?tab=all` alone is a legacy link: every note. The page itself always writes `unread=` next to `tab=all`.
  if (s.tab === 'all') return { tab: 'all', unread: s.unread ?? false, note };
  if (s.tab) return { tab: s.tab, unread: s.unread ?? true, note };
  return { tab: null, unread: s.unread ?? null, note };
}

/**
 * The view of a URL without a tab, once the data is in:
 *  - a deep link to a note opens All, with Unread only on when that note is unread (so the list contains it);
 *  - no unread notes but posts waiting: To approve, so the sidebar badge never lands on an empty list;
 *  - otherwise All with Unread only on.
 */
export function autoView(o: { note: number | null; unreadIds: ReadonlySet<number>; waiting: number }): { tab: InboxTab; unread: boolean } {
  if (o.note != null) return { tab: 'all', unread: o.unreadIds.has(o.note) };
  if (o.unreadIds.size === 0 && o.waiting > 0) return { tab: 'approvals', unread: true };
  return { tab: 'all', unread: true };
}

/** The search to write for a view (defaults are left out; `tab=all` always says which, because a bare `tab=all` is the legacy link). */
export function toSearch(v: { tab: InboxTab; unread: boolean; note?: number | null }): InboxSearch {
  if (v.tab === 'approvals') return { tab: 'approvals' };
  return {
    tab: v.tab,
    ...(v.tab === 'all' || !v.unread ? { unread: v.unread } : {}),
    ...(v.note != null ? { note: v.note } : {}),
  };
}

/** `GET /api/agents/inbox` sends the 200 newest notes and has no paging (agents.service.ts). */
export const INBOX_LIMIT = 200;

// ── tabs ────────────────────────────────────────────────────────────────────

type SeverityTab = 'critical' | 'action' | 'fyi';
const TAB_SEVERITY: Record<SeverityTab, Severity> = { critical: 'critical', action: 'action', fyi: 'info' };

/** Whether a note of this severity is shown by the tab. `approvals` shows posts, not notes. */
export function inTab(severity: Severity, tab: InboxTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'approvals') return false;
  return TAB_SEVERITY[tab] === severity;
}

export interface TabCounts { all: number; critical: number; action: number; fyi: number }

export function tabCounts(items: ReadonlyArray<{ severity: Severity }>): TabCounts {
  const c: TabCounts = { all: 0, critical: 0, action: 0, fyi: 0 };
  for (const it of items) {
    c.all += 1;
    if (it.severity === 'critical') c.critical += 1;
    else if (it.severity === 'action') c.action += 1;
    else c.fyi += 1;
  }
  return c;
}

// ── rows ────────────────────────────────────────────────────────────────────

interface Dated { id: number; createdAt: string }

/** Newest first (the server already sends it so; this does not trust the order). */
export function newestFirst<T extends Dated>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.id - a.id);
}

/** One row of the list: a note, or the notes that repeat one problem (same `subject`), newest first. */
export interface NoteGroup<T> {
  key:   string;
  /** The newest note: it is what the row shows and what a click selects. */
  head:  T;
  items: T[];
}

/**
 * Repeats of one problem share a `subject` (`resource:threads:<id>`, `silent:telegram:@x:miss`): the All view shows them as
 * one row. A note without a subject is a row of its own. The server marks older notes of a subject read when a newer one is
 * posted, so with Unread only a group is mostly one note; the history matters when read notes are shown.
 */
export function groupBySubject<T extends { id: number; subject?: string | null }>(items: readonly T[]): Array<NoteGroup<T>> {
  const groups: Array<NoteGroup<T>> = [];
  const bySubject = new Map<string, NoteGroup<T>>();
  for (const it of items) {
    const subject = it.subject?.trim();
    const hit = subject ? bySubject.get(subject) : undefined;
    if (hit) { hit.items.push(it); continue; }
    const g: NoteGroup<T> = { key: subject ? `s:${subject}` : `n:${it.id}`, head: it, items: [it] };
    groups.push(g);
    if (subject) bySubject.set(subject, g);
  }
  return groups;
}

/** Every note its own row (the severity tabs). */
export function singleRows<T extends { id: number }>(items: readonly T[]): Array<NoteGroup<T>> {
  return items.map((it) => ({ key: `n:${it.id}`, head: it, items: [it] }));
}

/** The ids of the unread notes of some rows (what "Mark all as done" and a group's "Mark as done" send). */
export function unreadIdsOf<T extends { id: number; readAt: string | null }>(groups: ReadonlyArray<NoteGroup<T>>): number[] {
  return groups.flatMap((g) => g.items).filter((n) => !n.readAt).map((n) => n.id);
}

export const isUnread = (n: { readAt: string | null }): boolean => !n.readAt;

// ── selection ───────────────────────────────────────────────────────────────

export interface Selection<T> {
  group: NoteGroup<T>;
  note:  T;
  /** Position of the row in the list. */
  index: number;
}

/** The row holding the note with this id (any note of a group), or null. */
export function findNote<T extends { id: number }>(groups: ReadonlyArray<NoteGroup<T>>, id: number | null): Selection<T> | null {
  if (id == null) return null;
  const index = groups.findIndex((g) => g.items.some((n) => n.id === id));
  if (index < 0) return null;
  const group = groups[index];
  return { group, note: group.items.find((n) => n.id === id)!, index };
}

/**
 * The selected note on a wide screen: the one named by `wanted`; else the row that was selected before (`prev`), or the row
 * that took its place when it left the list (marked done: the next one moves up); else the first row. Empty list: null.
 */
export function selectNote<T extends { id: number }>(
  groups: ReadonlyArray<NoteGroup<T>>, wanted: number | null, prev?: { key: string | null; index: number } | null,
): Selection<T> | null {
  if (!groups.length) return null;
  const hit = findNote(groups, wanted);
  if (hit) return hit;
  if (prev) {
    const byKey = prev.key != null ? groups.findIndex((g) => g.key === prev.key) : -1;
    const index = byKey >= 0 ? byKey : Math.min(Math.max(prev.index, 0), groups.length - 1);
    return { group: groups[index], note: groups[index].head, index };
  }
  return { group: groups[0], note: groups[0].head, index: 0 };
}

// ── copy ────────────────────────────────────────────────────────────────────

/** "@space", or "Space · @space" when the agent's name differs from its handle; the emoji leads when there is one. */
export function agentLabel(a: { handle: string; name?: string | null; emoji?: string | null }, long = false): string {
  const lead = a.emoji ? `${a.emoji} ` : '';
  const name = long && a.name && a.name !== a.handle ? `${a.name} · ` : '';
  return `${lead}${name}@${a.handle}`;
}

export const notes = (n: number): string => `${n} ${n === 1 ? 'note' : 'notes'}`;

/** The toast after "Mark as done". One note reads exactly like the toast of NoteActions' "Got it", so the one with Undo replaces it. */
export const markedText = (n: number): string => (n === 1 ? 'Marked as done' : `Marked ${notes(n)} as done`);

export interface EmptyCopy { tone: 'clear' | 'neutral'; title: string; note: string }

/** The empty state of a notes tab. With Unread only on, an empty list is the good kind of empty. */
export function emptyCopy(tab: InboxTab, unread: boolean): EmptyCopy {
  if (!unread) {
    return tab === 'all'
      ? { tone: 'neutral', title: 'The inbox is empty', note: 'Agents post here when they change a skill, roll a change back or need a decision from you.' }
      : { tone: 'neutral', title: 'Nothing here yet', note: 'The agents have not posted a note of this kind.' };
  }
  switch (tab) {
    case 'critical': return { tone: 'clear', title: 'No critical notes', note: 'Broken connections and blocked budgets show up here.' };
    case 'action':   return { tone: 'clear', title: 'Nothing needs your decision', note: 'Decisions the agents hand over to you show up here.' };
    case 'fyi':      return { tone: 'clear', title: 'No news', note: 'Skill edits, fallbacks and other changes you may want to know about show up here.' };
    default:         return { tone: 'clear', title: 'All clear', note: 'Nothing needs you right now. New notes from the agents show up here.' };
  }
}

export const APPROVALS_EMPTY_NOTE = 'Agents in approval mode write posts in advance (the next day at 20:00), and each one shows up here before it is published.';

// ── technical details ───────────────────────────────────────────────────────

/** The lines of the "Technical details" block: key and value, aligned. */
export function techLines(it: { id: number; kind: string; severity: string; refType: string | null; refId: string | null; createdAt: string; subject?: string | null }): string {
  const rows: Array<[string, string]> = [
    ['id', String(it.id)],
    ['kind', it.kind],
    ['severity', it.severity],
    ['refType', it.refType ?? '—'],
    ['refId', it.refId ?? '—'],
    ...(it.subject ? [['subject', it.subject] as [string, string]] : []),
    ['createdAt', it.createdAt],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n');
}
