/**
 * Spec 103 §8: a locked slot is the owner's. It was made or edited through the Claude connector (or locked by the
 * owner), and the automation never replaces, re-plans or rewrites it: replans keep it and plan around it, the SLO
 * controller never replaces it, pre-flight and the config gate leave its topic and format, pause and mode sweeps
 * leave it (the publish-time guards still apply). The owner can still edit, move, skip, approve, reject, run or
 * unlock it.
 *
 * Use these fragments in every automation writer that touches planned or waiting slots, so the rule has one name.
 */

/** Who locked a slot (editor_slots.locked_by, migration 105). */
export const SLOT_LOCK_OWNERS = ['connector', 'owner'] as const;
export type SlotLockOwner = (typeof SLOT_LOCK_OWNERS)[number];

/** SQL: the slot is not locked. Prefix with a table alias where needed (`s.${UNLOCKED_SQL}` does not work — use unlockedSql('s')). */
export const UNLOCKED_SQL = 'locked_by IS NULL';
/** SQL: the slot is locked. */
export const LOCKED_SQL = 'locked_by IS NOT NULL';

/** `alias.locked_by IS NULL` for a query that aliases editor_slots. */
export function unlockedSql(alias?: string): string {
  return alias ? `${alias}.locked_by IS NULL` : UNLOCKED_SQL;
}
/** `alias.locked_by IS NOT NULL`. */
export function lockedSql(alias?: string): string {
  return alias ? `${alias}.locked_by IS NOT NULL` : LOCKED_SQL;
}

/** True when the automation must leave the slot alone. */
export function isLocked(slot: { lockedBy?: string | null } | null | undefined): boolean {
  return !!slot?.lockedBy;
}

/**
 * Error prefixes of a slot the owner closed. The SLO controller and silent-day detectors treat them as the owner's
 * decision (never a miss to make up). `skipPlannedSlot(id, …)` writes the first; the chat card the second; the
 * connector's cancel_post the third.
 */
export const OWNER_SKIP_PREFIX           = 'skipped by owner';
export const OWNER_CHAT_SKIP_PREFIX      = 'skipped by the owner (chat)';
export const CONNECTOR_SKIP_PREFIX       = 'skipped by owner (connector)';
export const OWNER_SKIP_PREFIXES: readonly string[] = [CONNECTOR_SKIP_PREFIX, OWNER_CHAT_SKIP_PREFIX, OWNER_SKIP_PREFIX];

/** The error text a connector cancel writes. */
export function connectorSkipError(reason?: string | null): string {
  const r = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return r ? `${CONNECTOR_SKIP_PREFIX}: ${r}` : CONNECTOR_SKIP_PREFIX;
}

/** True for an error a skip by the owner wrote (any surface). */
export function isOwnerSkip(error: string | null | undefined): boolean {
  const e = (error ?? '').trim();
  return OWNER_SKIP_PREFIXES.some((p) => e === p || e.startsWith(`${p}:`) || e.startsWith(`${p} `));
}
