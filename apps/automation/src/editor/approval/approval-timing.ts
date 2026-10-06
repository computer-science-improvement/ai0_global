import type { EditorCard } from '../card';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { localDate, localHour, zonedToUtc } from '../roles/time';

/**
 * When an approval-mode slot is written (spec 031 FR-003) and how long its post
 * may wait (FR-007). Pure functions of the slot, its card and the clock.
 */

/** The next day's batch is written at 20:00 in the resource's zone, so the owner approves it in the evening. */
export const APPROVAL_BATCH_HOUR = 20;
/** A plan made while the batch is being written (20:00–22:00) still belongs to the batch. */
export const BATCH_WINDOW_MS = 2 * 3600_000;
/** A slot created less than 12 h ahead is written at most 3 h before it is due. */
export const LATE_CREATED_AHEAD_MS = 12 * 3600_000;
export const LATE_LEAD_MS = 3 * 3600_000;
/** Time-sensitive formats (news, feed sources) are written 2 h before the slot… */
export const NEWS_LEAD_MS = 2 * 3600_000;
/** …and expire this long after the slot time when nobody approved them (their freshness deadline). */
export const FRESHNESS_GRACE_MS = 30 * 60_000;
/** Approving after the slot time publishes at once when the delay is under 2 h; later, the post moves to the next free time. */
export const APPROVE_LATE_MAX_MS = 2 * 3600_000;
/** The owner may edit an approved post until 2 minutes before its time. */
export const EDIT_LOCK_MS = 2 * 60_000;
/** A rejected post gets one replacement when at least this much time is left before the slot. */
export const REPLACEMENT_MIN_LEAD_MS = LATE_LEAD_MS;

export const DEFAULT_HOLD_HOURS = 6;
export const DEFAULT_LEAD_HOURS = 12;

const holdMs = (card: Pick<EditorCard, 'approvalHoldHours'>) => (card.approvalHoldHours ?? DEFAULT_HOLD_HOURS) * 3600_000;
const leadMs = (card: Pick<EditorCard, 'approvalLeadHours'>) => (card.approvalLeadHours ?? DEFAULT_LEAD_HOURS) * 3600_000;

/** 'YYYY-MM-DD' ± n days (calendar arithmetic, no zone). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const NEWS_RE = /(^|[^a-zа-яіїєґ])(news|rss|feed|новин|стрічк)/i;

/**
 * News and feed-sourced slots go stale quickly: written 2 h ahead with a
 * freshness deadline. A slot is time-sensitive when its format or topic says
 * news, or a source hint points at an RSS source of the card.
 */
export function isTimeSensitive(slot: Pick<EditorSlot, 'format' | 'topic' | 'sourceHints'>, card: Pick<EditorCard, 'sources'>): boolean {
  if (slot.format === 'news' || NEWS_RE.test(slot.format)) return true;
  const rss = card.sources.filter((s) => s.kind === 'rss');
  return slot.sourceHints.some((h) => /^(rss|feed):/i.test(h) || rss.some((s) => h === s.id || h === s.ref || h.startsWith(s.ref)))
    || /новин|breaking|news/i.test(slot.topic);
}

/** 20:00 (resource zone) of the day before the slot's local day: when its batch is written. */
export function batchTimeOf(scheduledAt: Date, tz: string): Date {
  return zonedToUtc(addDays(localDate(scheduledAt, tz), -1), `${APPROVAL_BATCH_HOUR}:00`, tz);
}

/**
 * When an approval-mode slot is written:
 *  • time-sensitive — 2 h before the slot;
 *  • planned before (or while) its evening batch — at the batch time;
 *  • added later — `approval_lead_hours` before it is due, capped at 3 h when
 *    it was created less than 12 h ahead. A write time in the past means "now".
 */
export function writeAt(
  slot: Pick<EditorSlot, 'scheduledAt' | 'format' | 'topic' | 'sourceHints'> & { createdAt?: Date | null },
  card: Pick<EditorCard, 'timezone' | 'sources' | 'approvalLeadHours'>,
): Date {
  const at = slot.scheduledAt.getTime();
  if (isTimeSensitive(slot, card)) return new Date(at - NEWS_LEAD_MS);
  const created = slot.createdAt ? slot.createdAt.getTime() : 0;
  const batch = batchTimeOf(slot.scheduledAt, card.timezone).getTime();
  if (created <= batch + BATCH_WINDOW_MS) return new Date(Math.min(batch, at));
  const ahead = at - created;
  const lead = ahead < LATE_CREATED_AHEAD_MS ? Math.min(leadMs(card), LATE_LEAD_MS) : leadMs(card);
  return new Date(at - lead);
}

/** The freshness deadline a written time-sensitive post carries (null for evergreen posts). */
export function freshnessDeadline(
  slot: Pick<EditorSlot, 'scheduledAt' | 'format' | 'topic' | 'sourceHints'>, card: Pick<EditorCard, 'sources'>,
): Date | null {
  return isTimeSensitive(slot, card) ? new Date(slot.scheduledAt.getTime() + FRESHNESS_GRACE_MS) : null;
}

/** When a waiting post expires: its freshness deadline, else `approval_hold_hours` after its slot time. */
export function expiresAt(
  slot: Pick<EditorSlot, 'scheduledAt'> & { freshnessDeadline?: Date | null }, card: Pick<EditorCard, 'approvalHoldHours'>,
): Date {
  const hold = slot.scheduledAt.getTime() + holdMs(card);
  return new Date(slot.freshnessDeadline ? Math.min(slot.freshnessDeadline.getTime(), hold) : hold);
}

/** The local date whose batch is due now (tomorrow, from 20:00 on), or null before the batch hour. */
export function batchDateDue(now: Date, card: Pick<EditorCard, 'timezone'>): string | null {
  return localHour(now, card.timezone) >= APPROVAL_BATCH_HOUR ? addDays(localDate(now, card.timezone), 1) : null;
}
