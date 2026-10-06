// Spec 027 FR-010/FR-011: menu counters. Pure.
import type { BadgeKey } from './registry';

export type BadgeTone = 'danger' | 'warning' | 'accent';

export interface BadgeView {
  count: number;
  tone:  BadgeTone;
  /** Tooltip / screen-reader text, e.g. "3 posts awaiting approval". */
  title: string;
}

/** Every counter the menu knows. null = unknown (source failed or missing): no badge. */
export interface BadgeCounts {
  approvalsWaiting?: number | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The counter an item with badge `key` shows, or null for none (zero, null or unknown). */
export function badgeFor(key: BadgeKey | null, c: BadgeCounts): BadgeView | null {
  if (key === 'approvals') {
    const n = c.approvalsWaiting ?? 0;
    return n > 0 ? { count: n, tone: 'warning', title: `${plural(n, 'post', 'posts')} awaiting approval` } : null;
  }
  return null;
}
