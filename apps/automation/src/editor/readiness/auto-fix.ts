/**
 * Spec 072 FR-004, lead decision I3: the two lists that decide what code may fix without the owner.
 *
 * `AUTO_SAFE_FIX_KINDS` is closed: the readiness service applies these by itself (when `READINESS_AUTO_FIX` is on) and no
 * other kind. A test fails if the list changes, so adding a third is a decision somebody sees. Every other fix is one tap.
 *
 * `FIX_ALL_EXCLUDED_KINDS` are kinds "Fix all" and the owner bot's «Виправити все» skip: they need the owner's eyes on
 * one row. `bind_dataset` and `dataset_patch` are 075's kinds (W2); until they join `FIX_KINDS` they are plain strings, so this
 * file does not import them and the list is already final (lead decision I3, contract: owned by 072).
 */
export const AUTO_SAFE_FIX_KINDS = ['tools_allow_add', 'hashtag_min_zero'] as const;
export type AutoSafeFixKind = typeof AUTO_SAFE_FIX_KINDS[number];

export const FIX_ALL_EXCLUDED_KINDS: readonly string[] = ['bind_dataset', 'dataset_patch'];

export const isAutoSafeFix = (kind: string): boolean => (AUTO_SAFE_FIX_KINDS as readonly string[]).includes(kind);
export const isFixAllKind = (kind: string): boolean => !FIX_ALL_EXCLUDED_KINDS.includes(kind);
