/**
 * Spec 072 FR-004, lead decision I3: the two lists that decide what code may fix without the owner.
 *
 * `AUTO_SAFE_FIX_KINDS` is closed: the readiness service applies these by itself (when `READINESS_AUTO_FIX` is on) and no
 * other kind. A test fails if the list changes, so adding a third is a decision somebody sees. Every other fix is one tap.
 *
 * `FIX_ALL_EXCLUDED_KINDS` are kinds "Fix all" and the owner bot's «Виправити все» skip: they need the owner's eyes on
 * one row. `bind_dataset` and `dataset_patch` are 075's kinds (W2); until they join `FIX_KINDS` they are plain strings, so this
 * file does not import them (lead decision I3, contract: owned by 072). `source_drop` (076) joined at the 076 merge (lead
 * decision S9): it removes a source from the card, which cannot be undone in one tap, so it is never part of a batch.
 * `host_proxy_add` (076) is not excluded: adding a host to the proxy list is harmless and reversible in Settings.
 */
export const AUTO_SAFE_FIX_KINDS = ['tools_allow_add', 'hashtag_min_zero'] as const;
export type AutoSafeFixKind = typeof AUTO_SAFE_FIX_KINDS[number];

export const FIX_ALL_EXCLUDED_KINDS: readonly string[] = ['bind_dataset', 'dataset_patch', 'source_drop'];

/**
 * Lead decision I5 (073 × 072 merge): the slot repairs the runner makes by itself at $0 before a paid run (spec 073 FR-009):
 * the slot takes its series' format, and its source hints are set back to the series' own dataset. They are not `Fix` kinds
 * (nothing in the channel's setup changes, only the planned slot), so they are a list of their own. `isRepairable` in
 * `readiness/slot-config.ts` reads this list, and the doctor shows such a problem as info ("will be repaired before the run").
 */
export const AUTO_SAFE_RUN_REPAIRS = ['config_format_mismatch', 'config_source_mismatch'] as const;

export const isAutoSafeFix = (kind: string): boolean => (AUTO_SAFE_FIX_KINDS as readonly string[]).includes(kind);
export const isFixAllKind = (kind: string): boolean => !FIX_ALL_EXCLUDED_KINDS.includes(kind);
