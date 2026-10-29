import { reasonFor, type ReasonEntry } from '../reasons/catalogue';

/**
 * Spec 076 FR-008 / L4 / A31: the owner-visible codes of the source checks and notes.
 *
 * Their entries live in 073's one catalogue (`reasons/catalogue.ts`, mirrored by the dashboard's `lib/reasons.ts`); the W1 copy
 * of `ReasonEntry` and of the seven entries was swapped for the catalogue's import at the lead's merge.
 *
 * - The five finding codes are `doctor` entries, as 072's doctor codes are. `source_unreachable` is the skip class and the pause
 *   cause, never a code here (the doctor's code for the same fact is `source_probe_failed`).
 * - The two note codes are `source` entries and are the notes' own Inbox kinds: `host_struck` (not `host_unreachable`, which is
 *   already a tool error code that 073's `reasonOfError` would misread) and `resync_failed`.
 */
export type { ReasonEntry };

export const SOURCE_REASON_CODES = [
  'source_probe_failed', 'source_empty', 'source_untested', 'card_without_sources', 'dataset_resync_manual', 'host_struck', 'resync_failed',
] as const;

export const SOURCE_REASONS: ReasonEntry[] = SOURCE_REASON_CODES.map((code) => {
  const e = reasonFor(code);
  if (!e) throw new Error(`reason catalogue: no entry for the source code ${code}`);
  return e;
});

const BY_CODE = new Map(SOURCE_REASONS.map((r) => [r.code, r]));

/** The entry of one of these codes; undefined for any other code (the catalogue's other entries are not source codes). */
export const sourceReason = (code: string): ReasonEntry | undefined => BY_CODE.get(code);
