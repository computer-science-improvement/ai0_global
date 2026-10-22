import { skipGroupOf } from '../silent/skip-reasons';

/**
 * Spec 061 FR-003: what happens to a pool idea once none of its slots is pending. `used` only when a slot of the idea went
 * out; a skip returns the idea to the pool or closes it, by what stopped the slot:
 *   infra, budget, preflight_format_unavailable, series_paused, a cap or a quiet hour  → back to `accepted` (may be planned again);
 *   no material, source unreachable or spent (preflight_*, no_fresh_item, host_blocked)  → `rejected`, the reason in `review`;
 *   critic and every content failure (lint, similarity)  → `used`, unchanged (rejectSoleSourceIdeas handles a dead source).
 */

/** A slot status that means the post is out or waits for the owner. */
export const OUT_STATUSES = ['published', 'shadowed', 'awaiting_approval', 'approved'] as const;

export type IdeaOutcome =
  | { status: 'used' }
  | { status: 'accepted'; reason: string }
  | { status: 'rejected'; reason: string };

const BACK_TO_POOL = [
  /^preflight_format_unavailable\b/,
  /^series_paused\b/,
  /^(budget|budget_exceeded)\b/,
  /^(retry after|too_late|outage|llm_|infra)/,
];
const NO_MATERIAL = [
  /^preflight_(source_used|stale|host_blocked)\b/,
  /^no_fresh_item\b/,
  /^source_not_published\b/,
  /^(host_blocked|host_unreachable)\b/,
];

/** The outcome of an idea whose last slot ended `status` with `error` (the slot's error text is the record). */
export function ideaOutcomeOf(status: string, error: string | null | undefined, criticVerdict?: string | null): IdeaOutcome {
  if ((OUT_STATUSES as readonly string[]).includes(status)) return { status: 'used' };
  const e = (error ?? '').trim();
  const reason = e.slice(0, 300) || status;
  if (NO_MATERIAL.some((r) => r.test(e))) return { status: 'rejected', reason };
  if (BACK_TO_POOL.some((r) => r.test(e))) return { status: 'accepted', reason };
  const group = skipGroupOf(e, criticVerdict);
  if (group === 'nothing_fresh') return { status: 'rejected', reason };
  if (group === 'budget' || group === 'cap') return { status: 'accepted', reason };
  // A slot that failed by a crash or a timeout (not on its content) did not test the idea.
  if (status === 'failed' && /^(max_steps|no_terminal|error|disabled|timeout)\b/.test(e)) return { status: 'accepted', reason };
  return { status: 'used' };
}
