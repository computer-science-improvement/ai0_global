import type { EditorCard } from '../card';
import type { PlannedSlotLike, SlotPreflight } from './slot-preflight';

/**
 * Spec 068 FR-007: the cheap pre-flight checks at plan time. What code can already tell about a slot's source or row (spent,
 * stale, blocked host, a library row without text, an empty dataset, a format that cannot be produced here) is told to the
 * planner while it can still choose, instead of the executor finding out when the slot is due.
 * Host blocks are checked again at run time: some appear after the plan is made.
 */

/** What the planner may do about a refused slot (the single-channel plan: `skipped_series` or `short_day`). */
export const PLAN_TIME_WAY_OUT = 'заміни джерело/рядок або постав skipped_series з cause no_material / short_day';
/** The same for a network plan, which has `short_days` (one per resource) and no `short_day`. */
export const NETWORK_PLAN_TIME_WAY_OUT = 'заміни джерело/рядок або постав skipped_series з cause no_material / short_days [{resource_ref, cause, reason}]';

export interface PlanTimeSlot {
  /** «слот 2 (12:00)» as the other plan errors name it. */
  label: string;
  slot:  PlannedSlotLike;
}

/**
 * One `plan_invalid` line per slot the pre-flight would stop. Without a pre-flight (tests, a deployment that has none) nothing is refused.
 * `wayOut` is what the planner is told it may do instead (default: the single-channel plan's).
 */
export async function planTimePreflightErrors(
  pf: Pick<SlotPreflight, 'assessPlanned'> | undefined, card: EditorCard, slots: PlanTimeSlot[], wayOut: string = PLAN_TIME_WAY_OUT,
): Promise<string[]> {
  if (!pf) return [];
  const out: string[] = [];
  for (const { label, slot } of slots) {
    const problem = await pf.assessPlanned(slot, card);
    if (!problem) continue;
    out.push(`${label}: ${problem.reason} — ${problem.code === 'preflight_format_unavailable' ? 'обери інший формат' : wayOut}`);
  }
  return out;
}

/**
 * Spec 068 FR-007 (review fix R1): an experiment quota in a format that cannot be produced here (a carousel without slide hosting)
 * does not force a slot, or no plan could ever satisfy it: the slot would fail the format check and any other format the quota's.
 * Without a `formatOk` (no settings in this context) nothing is dropped.
 */
export function producibleQuotas<Q extends { format: string | null }>(quotas: Q[], formatOk?: (format: string) => boolean): Q[] {
  return quotas.filter((q) => !q.format || !formatOk || formatOk(q.format));
}
