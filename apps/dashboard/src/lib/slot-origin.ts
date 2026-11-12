// Spec 103 FR-E: where a slot came from and whether the automation may touch it. Origin and lock are not statuses
// (those live in status-tone.ts); they are two small facts shown next to the status.

export type SlotLockOwner = 'connector' | 'owner';

/** The fields every slot-shaped payload may carry (an older server sends none of them). */
export interface SlotOriginFields {
  createdVia?: 'connector' | null;
  lockedBy?:   SlotLockOwner | null;
  lockedAt?:   string | null;
}

export const isConnectorSlot = (s: SlotOriginFields | null | undefined): boolean => s?.createdVia === 'connector';
export const isLockedSlot = (s: SlotOriginFields | null | undefined): boolean => !!s?.lockedBy;

/** "connector" for a slot made through the Claude connector, else null. */
export function originLabel(s: SlotOriginFields | null | undefined): string | null {
  return isConnectorSlot(s) ? 'connector' : null;
}

/** "locked" for a slot the automation must not overwrite, else null. */
export function lockedLabel(s: SlotOriginFields | null | undefined): string | null {
  return isLockedSlot(s) ? 'locked' : null;
}

export function originTooltip(s: SlotOriginFields | null | undefined): string {
  return isConnectorSlot(s) ? 'Created from Claude through the connector' : '';
}

export function lockedTooltip(s: SlotOriginFields | null | undefined): string {
  if (!isLockedSlot(s)) return '';
  const who = s!.lockedBy === 'connector' ? 'from Claude' : 'by you';
  return `Locked ${who}: replans and the planner leave it alone. Unlock it to hand it back to the agent.`;
}

/** Short facts for calendar and plan tooltips; empty when the slot is plain. */
export function originFacts(s: SlotOriginFields | null | undefined): string {
  const parts: string[] = [];
  if (isConnectorSlot(s)) parts.push('via connector');
  if (isLockedSlot(s)) parts.push('locked');
  return parts.join(' · ');
}

/** A chat started from Claude through the connector. */
export const isConnectorChat = (c: { createdVia?: string | null } | null | undefined): boolean => c?.createdVia === 'connector';
