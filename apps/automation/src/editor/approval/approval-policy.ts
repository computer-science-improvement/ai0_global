import type { ChannelMode } from '../card';

/**
 * Approval-mode rules other specs plug into (spec 031 FR-009). Pure functions,
 * so 023 (series and schedule changes, strategy cutover) and 024 (resource
 * variants) call one place instead of re-deciding what approval mode means.
 */

/** 023: the silent series time shift that live mode may apply without asking. */
export const SILENT_SHIFT_MAX_MINUTES = 90;

/**
 * 023 FR-009: does a schedule change (a series time shift, a moved slot, a new
 * cadence) need the owner's card? In `approve` every change does; in `live`
 * only shifts beyond the silent window; `shadow`/`off` publish nothing, so a
 * card would only be noise.
 */
export function scheduleChangeNeedsCard(mode: ChannelMode, shiftMinutes: number): boolean {
  if (mode === 'approve') return true;
  if (mode === 'live') return Math.abs(shiftMinutes) > SILENT_SHIFT_MAX_MINUTES;
  return false;
}

/** 023 FR-012: a strategy cutover hands the resource to the agents in approval mode, never straight to live. */
export const CUTOVER_TARGET_MODE: ChannelMode = 'approve';

/**
 * 024: the waiting posts that belong together on one card — the variants of one
 * idea across resources (duplicate, adapt, unique). Each variant stays its own
 * waiting post; «Апрувнути всі варіанти» is POST /api/editor/approvals/bulk
 * with `idea_id` (already served). Posts without an idea stand alone.
 */
export function variantGroupKey(slot: { id: string; ideaId?: string | null }): string {
  return slot.ideaId ? `idea:${slot.ideaId}` : `slot:${slot.id}`;
}
