// Spec 103: what "Approve all" can approve, and what its toast says. Locked posts (made through the Claude connector,
// or locked by the owner) are never bulk-approved by the backend: they are approved one by one.

import { isLockedSlot, type SlotOriginFields } from './slot-origin';

export interface BulkCandidate extends SlotOriginFields { lintWarnings: unknown[]; critic?: unknown }

/** Posts a bulk approve will take: no lint warnings, not held by the critic, not locked. */
export function bulkApprovable<T extends BulkCandidate>(waiting: T[], held: (critic: T['critic']) => boolean): number {
  return waiting.filter((i) => !i.lintWarnings.length && !held(i.critic) && !isLockedSlot(i)).length;
}

const posts = (n: number) => `${n} ${n === 1 ? 'post' : 'posts'}`;

export interface BulkResult { approved: number; skippedWithWarnings: number; conflicts: number; skippedLocked?: number }

export function bulkApproveToast(r: BulkResult, label: string): string {
  const parts = [`Approved ${posts(r.approved)} (${label})`];
  if (r.skippedWithWarnings) parts.push(`${r.skippedWithWarnings} with warnings or critic notes — review them one by one`);
  if (r.skippedLocked) parts.push(`${r.skippedLocked} locked ${r.skippedLocked === 1 ? 'post' : 'posts'}: approve them one by one`);
  if (r.conflicts) parts.push(`${r.conflicts} already decided`);
  return parts.join('; ');
}
