// Spec 027 FR-010/FR-011: menu counters. Pure.
import type { BadgeKey } from './registry';
import type { ResolvedItem } from './model';

export type BadgeTone = 'danger' | 'warning' | 'accent';

export interface BadgeView {
  count: number;
  tone:  BadgeTone;
  /** Tooltip / screen-reader text, e.g. "3 posts awaiting approval". */
  title: string;
}

/**
 * Every counter the menu knows: GET /api/nav/badges `counts` plus the approvals
 * count (GET /api/editor/approvals/count, spec 031). null/undefined = unknown
 * (source failed or missing): no badge.
 */
export interface BadgeCounts {
  approvalsWaiting?:        number | null;
  agentInboxUnread?:        number | null;
  agentInboxCritical?:      number | null;
  directivesAwaitingOwner?: number | null;
  chatPendingActions?:      number | null;
  dmThreadsNew?:            number | null;
  dmActionsPending?:        number | null;
  slotsFailedToday?:        number | null;
  scheduledFailedToday?:    number | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const known = (...xs: Array<number | null | undefined>) => xs.some((x) => typeof x === 'number');
const sum = (...xs: Array<number | null | undefined>) => xs.reduce<number>((s, x) => s + (typeof x === 'number' && x > 0 ? x : 0), 0);

/** The counter an item with badge `key` shows, or null for none (zero, null or unknown). */
export function badgeFor(key: BadgeKey | null, c: BadgeCounts): BadgeView | null {
  if (!key) return null;
  const view = (count: number, tone: BadgeTone, title: string): BadgeView | null => (count > 0 ? { count, tone, title } : null);
  switch (key) {
    case 'approvals':
      return view(sum(c.approvalsWaiting), 'warning', `${plural(sum(c.approvalsWaiting), 'post', 'posts')} awaiting approval`);
    case 'agents': {
      if (!known(c.agentInboxUnread, c.directivesAwaitingOwner)) return null;
      const inbox = sum(c.agentInboxUnread);
      const dirs = sum(c.directivesAwaitingOwner);
      const parts = [inbox ? `${inbox} unread in the agent inbox` : '', dirs ? `${plural(dirs, 'directive awaits', 'directives await')} you` : ''].filter(Boolean);
      return view(inbox + dirs, sum(c.agentInboxCritical) > 0 || dirs > 0 ? 'danger' : 'warning', parts.join(' · '));
    }
    case 'agentsInbox':
      return view(sum(c.agentInboxUnread), sum(c.agentInboxCritical) > 0 ? 'danger' : 'warning',
        `${sum(c.agentInboxUnread)} unread${sum(c.agentInboxCritical) ? `, ${sum(c.agentInboxCritical)} critical` : ''}`);
    case 'directives':
      return view(sum(c.directivesAwaitingOwner), 'danger', `${plural(sum(c.directivesAwaitingOwner), 'directive awaits', 'directives await')} your decision`);
    case 'chat':
      return view(sum(c.chatPendingActions), 'warning', `${plural(sum(c.chatPendingActions), 'change', 'changes')} to confirm in the chat`);
    case 'dm': {
      const threads = sum(c.dmThreadsNew);
      const replies = sum(c.dmActionsPending);
      const parts = [threads ? plural(threads, 'new DM', 'new DMs') : '', replies ? `${plural(replies, 'reply', 'replies')} to approve` : ''].filter(Boolean);
      return view(threads + replies, 'warning', parts.join(' · '));
    }
    case 'editor':
      return view(sum(c.slotsFailedToday), 'danger', `${plural(sum(c.slotsFailedToday), 'slot', 'slots')} failed today`);
    case 'scheduled':
      return view(sum(c.scheduledFailedToday), 'danger', `${plural(sum(c.scheduledFailedToday), 'post', 'posts')} failed today`);
    default:
      return null;
  }
}

/** The pill text: capped at 99+ (FR-011). */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

const RANK: Record<BadgeTone, number> = { accent: 0, warning: 1, danger: 2 };

/** Counters that already include others: the Agents item sums the agent inbox and the directives. */
const COVERS: Partial<Record<BadgeKey, BadgeKey[]>> = { agents: ['agentsInbox', 'directives'] };

/** Badge keys the visible menu already shows (directly or inside a sum). */
export function shownKeys(visible: ResolvedItem[]): Set<BadgeKey> {
  const out = new Set<BadgeKey>();
  for (const it of visible) if (it.badge) { out.add(it.badge); for (const k of COVERS[it.badge] ?? []) out.add(k); }
  return out;
}

/**
 * The strongest counter among `items` (FR-011/FR-014: the mobile hamburger dot,
 * and hidden items rolling up), with a combined title. `skip`: keys already
 * shown elsewhere. null when nothing counts.
 */
export function rollup(items: ResolvedItem[], c: BadgeCounts, skip: Set<BadgeKey> = new Set()): { tone: BadgeTone; title: string; count: number } | null {
  const seen = new Set<string>(skip);
  let best: BadgeTone | null = null;
  const titles: string[] = [];
  let count = 0;
  for (const it of items) {
    if (!it.badge || seen.has(it.badge)) continue;
    seen.add(it.badge);
    const b = badgeFor(it.badge, c);
    if (!b) continue;
    count += b.count;
    titles.push(`${it.label}: ${b.title}`);
    if (!best || RANK[b.tone] > RANK[best]) best = b.tone;
  }
  return best ? { tone: best, title: titles.join('\n'), count } : null;
}
