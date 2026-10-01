// posted-error.ts — the "poisoned item" marker for pool-backed content tables.
//
// Every pool table (prompts, assets, birthdays, quotes, recipes, facts…) already
// tracks per-destination publication in a `posted` JSONB keyed by the
// destination's postedKey ('TELEGRAM', '@channel', 'IG:<uuid>', …). A row that
// can never be published for a destination (dead page/image, model SKIP_POST
// or empty draft, a permanent publish rejection) is marked in the SAME column
// under `error:<postedKey>` = {at, reason}. getNext/countEligible exclude that
// key alongside the posted key, so the row is skipped for that destination
// without inflating "posted" counts and stays inspectable/reversible:
//
//   UPDATE <table> SET posted = posted - 'error:TELEGRAM' WHERE id = '…';
//
// No migration needed. posted_news-backed strategies use
// DedupService.markError() instead (content_type = 'error').

export const POSTED_ERROR_PREFIX = 'error:';

/** The `posted` JSONB key that marks a row as unpublishable for `postedKey`. */
export function postedErrorKey(postedKey: string): string {
  return `${POSTED_ERROR_PREFIX}${postedKey}`;
}

/**
 * SET-clause value for markError: `posted || {"error:<key>": {at, reason}}`.
 * Placeholders: $2 = postedErrorKey(key), $3 = reason.
 */
export const MARK_ERROR_SET = `posted = posted || jsonb_build_object($2::text, jsonb_build_object('at', now(), 'reason', $3::text))`;
