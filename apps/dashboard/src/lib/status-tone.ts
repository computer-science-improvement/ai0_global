// The ONE status map of the dashboard (spec 078 D2): tone, label and mark shape of an `editor_slots` status and of a
// `scheduled_publications` status, plus the two computed states the API does not store: "missed" and "not planned".
// `Badge` (table cells) reads the tone, `StatusMark` (timelines, calendar chips, legends) reads the shape.
// Pure: no React, so it is node-tested (status-tone.test.ts).

import type { Tone } from '../components/ui/primitives';
import type { EditorSlotStatus, ScheduledPost } from '../api/types';

export type SlotStatus = EditorSlotStatus;
export type PublicationStatus = ScheduledPost['status'];

/** Everything `StatusMark` can draw: a slot status, a computed state, or the owner's own post ("yours"). */
export type MarkKind = SlotStatus | 'missed' | 'not_planned' | 'yours';

/** Badge tone of a slot status (`--color-accent` and `--color-success` are one green, so the SHAPE tells them apart). */
export const SLOT_TONE: Record<SlotStatus, Tone> = {
  planned: 'neutral', running: 'accent', awaiting_approval: 'warning', approved: 'accent', shadowed: 'neutral',
  published: 'success', skipped: 'neutral', failed: 'danger', expired: 'warning',
};

/** Badge tone of the computed states and of the owner's post. */
const COMPUTED_TONE = { missed: 'warning', not_planned: 'warning', yours: 'neutral' } as const satisfies Record<'missed' | 'not_planned' | 'yours', Tone>;

/** Badge tone of a scheduled (owner-composed) publication. */
export const PUBLICATION_TONE: Record<PublicationStatus, Tone> = {
  pending: 'neutral', sending: 'accent', sent: 'success', failed: 'danger', canceled: 'neutral',
  unknown: 'warning', // was mid-send when the service died: delivery unconfirmed
};

/** Owner-facing names (sentence case) of every mark; also the `aria-label` of `StatusMark`. */
export const MARK_LABEL: Record<MarkKind, string> = {
  planned: 'Planned', running: 'Running', awaiting_approval: 'Awaiting approval', approved: 'Approved', shadowed: 'Shadowed',
  published: 'Published', skipped: 'Skipped', failed: 'Failed', expired: 'Expired',
  missed: 'Missed', not_planned: 'Not planned', yours: 'Your post',
};

export const PUBLICATION_LABEL: Record<PublicationStatus, string> = {
  pending: 'Scheduled', sending: 'Sending', sent: 'Sent', failed: 'Failed', canceled: 'Canceled', unknown: 'Unconfirmed',
};

/** Legend order of the marks: the day goes left to right through them. */
export const MARK_ORDER: readonly MarkKind[] = [
  'planned', 'running', 'awaiting_approval', 'approved', 'shadowed', 'published', 'skipped', 'failed', 'expired', 'missed', 'not_planned', 'yours',
];

/**
 * Tone of a slot status. `null` / `undefined` is a slot the planner has not written yet ("not planned", warning);
 * a status this build does not know is neutral.
 */
export function slotTone(status: string | null | undefined): Tone {
  if (status == null) return COMPUTED_TONE.not_planned;
  return SLOT_TONE[status as SlotStatus] ?? 'neutral';
}

/** Tone of any mark kind (a legend or a chip that already has its `MarkKind`). */
export function markTone(kind: MarkKind): Tone {
  return kind in COMPUTED_TONE ? COMPUTED_TONE[kind as keyof typeof COMPUTED_TONE] : SLOT_TONE[kind as SlotStatus];
}

export function publicationTone(status: string): Tone {
  return PUBLICATION_TONE[status as PublicationStatus] ?? 'neutral';
}

export function publicationLabel(status: string): string {
  return PUBLICATION_LABEL[status as PublicationStatus] ?? status;
}

/** Label of a slot status or `null` (not planned); an unknown status is shown as the API wrote it. */
export function slotLabel(status: string | null | undefined): string {
  if (status == null) return MARK_LABEL.not_planned;
  return MARK_LABEL[status as MarkKind] ?? status.replace(/_/g, ' ');
}

// ── missed ──────────────────────────────────────────────────────────────────
// A slot of a series or a pin that did not go out and was not the owner's or the system's own decision.
// These two lists mirror apps/automation/src/editor/silent/skip-reasons.ts (NOT_A_MISS, OWNER); status-tone.test.ts reads
// that file and fails when they drift apart.

/** Skips that are the system's own bookkeeping (a replan, a mode change, a cancelled draft, a paused series): never a miss. */
export const NOT_A_MISS: readonly RegExp[] = [/^superseded by a new plan/, /^mode_changed/, /^draft canceled/, /^series_paused\b/];
/** Skips that are the owner's own decision (rejected, paused): not a miss either, the owner knows. */
export const OWNER_DECISION: readonly RegExp[] = [/^rejected by owner/, /^resource_paused/, /^agent @.* is paused/, /^agent paused/];

/** The slot fields the miss rule reads (an `EditorSlot` or an `/api/upcoming` row both fit). */
export interface MissCandidate {
  status: string | null;
  error?: string | null;
  seriesName?: string | null;
  scheduleRuleId?: string | null;
}

const MISS_STATUSES = new Set(['skipped', 'failed', 'expired']);

/** The error is a skip the system chose (superseded plan, mode change, cancelled draft, paused series). */
export function isNotAMiss(error: string | null | undefined): boolean {
  const e = (error ?? '').trim();
  return NOT_A_MISS.some((r) => r.test(e));
}

/** The error is the owner's own decision (rejected by the owner, a paused resource or agent). */
export function isOwnerDecision(error: string | null | undefined): boolean {
  const e = (error ?? '').trim();
  return OWNER_DECISION.some((r) => r.test(e));
}

/**
 * Did this slot miss? It belongs to a series or a pin (`seriesName` / `scheduleRuleId`), it ended `skipped`, `failed` or
 * `expired`, and its error is neither bookkeeping (`NOT_A_MISS`) nor the owner's decision (`OWNER_DECISION`).
 * (The handoff's pseudo-code mixes `||` and `&&` without parentheses: the series test must wrap the whole rule.)
 */
export function isMissed(slot: MissCandidate): boolean {
  const inSeriesOrRule = slot.seriesName != null || slot.scheduleRuleId != null;
  return inSeriesOrRule
    && slot.status != null && MISS_STATUSES.has(slot.status)
    && !isNotAMiss(slot.error)
    && !isOwnerDecision(slot.error);
}

/** The mark of a slot: `missed` when it missed, `not_planned` when it has no status yet, else its status (unknown → planned). */
export function slotMark(slot: MissCandidate): MarkKind {
  if (isMissed(slot)) return 'missed';
  if (slot.status == null) return 'not_planned';
  return slot.status in SLOT_TONE ? (slot.status as SlotStatus) : 'planned';
}
