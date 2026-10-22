/**
 * Spec 037 FR-010 (T10): why a content slot did not go out, grouped for the MANAGER digest and the Inbox alerts.
 *
 * The slot's `error` text is the record (every path that skips or fails a slot writes a stable prefix); the critic
 * verdict separates an executor's own skip after a `revise` (the critic drove it) from a plain editorial skip.
 */

export const SKIP_GROUPS = ['critic', 'lint', 'cap', 'nothing_fresh', 'budget', 'other'] as const;
export type SkipGroup = typeof SKIP_GROUPS[number];

/** Publish-tool errors that mean "this post / this material does not pass" — a content failure the fallback ladder retries. */
export const CONTENT_FAILURE_CODES = [
  'lint_failed', 'too_similar', 'too_verbatim', 'source_already_posted', 'library_item_already_posted', 'already_posted',
  'quiz_answer_mismatch', 'library_ref_not_found', 'series_source_mismatch', 'live_source_missing',
] as const;
const CONTENT = new Set<string>(CONTENT_FAILURE_CODES);
export const isContentFailureCode = (code: string | null | undefined): boolean => !!code && CONTENT.has(code);

/** Skips that are the owner's or the system's own decision, not a missed post (no alert, not counted as planned). */
const NOT_A_MISS = [/^superseded by a new plan/, /^mode_changed/, /^draft canceled/];
/** The owner's own decisions: counted as planned and not out, but never a `series_missed` alert. */
const OWNER = [/^rejected by owner/, /^resource_paused/, /^agent @.* is paused/, /^agent paused/];

const RULES: Array<[SkipGroup, RegExp]> = [
  ['critic', /^critic_(rejected|failed)\b/],
  ['budget', /^(budget_exceeded|budget\b)/],
  ['lint', /^(lint_failed|guard_failed|too_similar|too_verbatim|source_already_posted|library_item_already_posted|already_posted|quiz_answer_mismatch|series_source_mismatch|live_source_missing)\b/],
  ['cap', /^(daily_cap_reached|poll_cap_reached|min_gap|quiet_hours|blackout_window)\b/],
  ['nothing_fresh', /^(no_fresh_item\b|series ".*": required source .* has nothing left|source_not_published\b)/],
];

/** Is this slot error a skip the owner / system chose (a superseded plan, a mode change) rather than a miss? */
export function isNotAMiss(error: string | null | undefined): boolean {
  const e = (error ?? '').trim();
  return NOT_A_MISS.some((r) => r.test(e));
}

/** Is this slot error the owner's own decision (rejected, paused)? */
export function isOwnerDecision(error: string | null | undefined): boolean {
  const e = (error ?? '').trim();
  return OWNER.some((r) => r.test(e));
}

/**
 * The skip group of a slot that did not go out. `criticVerdict` is the verdict stored on the slot: an executor's
 * `skip_slot` after a first `revise` is a critic skip (the executor gave up on the rewrite the critic asked for).
 */
export function skipGroupOf(error: string | null | undefined, criticVerdict?: string | null): SkipGroup {
  const e = (error ?? '').trim();
  for (const [g, r] of RULES) if (r.test(e)) return g;
  if (/^skipped by agent\b/.test(e) && (criticVerdict === 'revise' || criticVerdict === 'reject')) return 'critic';
  // A run that hit a publish guard in its last step and ran out of steps / retries keeps the code after the status.
  if (/^(max_steps|no_terminal|error)\b.*\b(lint_failed|too_similar|too_verbatim)\b/.test(e)) return 'lint';
  return 'other';
}

/** Did the critic end this slot (a reject, a second revise, or the executor's skip after a revise)? */
export function isCriticRejection(error: string | null | undefined, criticVerdict?: string | null): boolean {
  const e = (error ?? '').trim();
  return /^critic_rejected\b/.test(e) || (/^skipped by agent\b/.test(e) && (criticVerdict === 'revise' || criticVerdict === 'reject'));
}

export type SkipCounts = Partial<Record<SkipGroup, number>>;

export function addSkip(c: SkipCounts, g: SkipGroup): SkipCounts {
  c[g] = (c[g] ?? 0) + 1;
  return c;
}

// ── Spec 061 FR-001: the slot pre-flight's skip codes ─────────────────────────
// `preflight_source_used` / `preflight_stale` leave nothing to write about (nothing_fresh); `preflight_host_blocked` is the
// source's host refusing us (nothing_fresh in the digest, `source_unreachable` as a cause); a missing format is `other` here
// and `infra` as a cause (spec 060 classes).
RULES.push(
  ['nothing_fresh', /^preflight_(source_used|stale|host_blocked)\b/],
  ['other', /^preflight_format_unavailable\b/],
);

/** The 060 cause class of a pre-flight skip (null for any other error). */
export function preflightCauseOf(error: string | null | undefined): 'no_material' | 'source_unreachable' | 'infra' | null {
  const e = (error ?? '').trim();
  if (/^preflight_(source_used|stale)\b/.test(e)) return 'no_material';
  if (/^preflight_host_blocked\b/.test(e)) return 'source_unreachable';
  if (/^preflight_format_unavailable\b/.test(e)) return 'infra';
  return null;
}
