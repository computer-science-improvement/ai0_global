import type { ContentLedger } from '../../data/content-ledger';

/**
 * Spec 071 FR-004: put a library row aside for the current round. A dataset that repeats in rounds must not stall on a
 * row no post can be made from: when the critic rejected the post for good, the revise step failed, a quiz answer key is
 * wrong, or the executor says so (`skip_slot` with `ref`), the row is recorded as `passed` on the slot's resource. It
 * counts as done in this round and comes back in the next. The ledger ignores every ref that is not a row of a cycle
 * dataset, so a `never` / `after_days` dataset is untouched.
 *
 * Best-effort like `deadSource`: a failure here never changes what happens to the slot.
 */

export interface PassRowSlot { id: string; channelKey: string; resourceRef?: string | null }

/** `slot`, the post's `library_ref`, the reason (kept as the ledger note). True when the row was put aside. */
export type PassRow = (slot: PassRowSlot, ref: string, reason: string) => Promise<boolean>;

export function makePassRow(ledger: Pick<ContentLedger, 'pass'>, log?: (m: string) => void): PassRow {
  return async (slot, ref, reason) => {
    try {
      return await ledger.pass(ref, {
        resourceRef: slot.resourceRef ?? `telegram:${slot.channelKey}`, origin: 'editor', slotId: slot.id, note: reason.slice(0, 300),
      });
    } catch (err: any) {
      log?.(`passRow ${ref} on slot ${slot.id}: ${err?.message ?? err}`);
      return false;
    }
  };
}
