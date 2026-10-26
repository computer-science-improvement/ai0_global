import type { EditorCard } from '../card';
import type { PlannedSlotLike, SlotPreflight } from './slot-preflight';

/**
 * Spec 068 FR-007: the cheap pre-flight checks at plan time. What code can already tell about a slot's source or row (spent,
 * stale, blocked host, a library row without text, an empty dataset, a format that cannot be produced here) is told to the
 * planner while it can still choose, instead of the executor finding out when the slot is due.
 * Host blocks are checked again at run time: some appear after the plan is made.
 */

/** What the planner may do about a refused slot. */
export const PLAN_TIME_WAY_OUT = 'заміни джерело/рядок або постав skipped_series з cause no_material / short_day';

export interface PlanTimeSlot {
  /** «слот 2 (12:00)» as the other plan errors name it. */
  label: string;
  slot:  PlannedSlotLike;
}

/** One `plan_invalid` line per slot the pre-flight would stop. Without a pre-flight (tests, a deployment that has none) nothing is refused. */
export async function planTimePreflightErrors(
  pf: Pick<SlotPreflight, 'assessPlanned'> | undefined, card: EditorCard, slots: PlanTimeSlot[],
): Promise<string[]> {
  if (!pf) return [];
  const out: string[] = [];
  for (const { label, slot } of slots) {
    const problem = await pf.assessPlanned(slot, card);
    if (!problem) continue;
    out.push(`${label}: ${problem.reason} — ${problem.code === 'preflight_format_unavailable' ? 'обери інший формат' : PLAN_TIME_WAY_OUT}`);
  }
  return out;
}
