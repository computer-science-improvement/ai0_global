/**
 * Spec 091 FR-001 and FR-002: the day's target of a channel and its state. Both pure; the controller loads the inputs.
 */
import type { SloState } from './types';

export interface TargetInput {
  /** The card's posts_per_day.min. */
  cardMin:          number;
  /** The anchor section's per_day for the day from the active playbook (frequency rules applied), or null. */
  playbookPerDay?:  { min: number; max: number } | null;
  /** Daily posts owed to series the OWNER paused (they are not owed). No-material / unreachable pauses do not count. */
  ownerPausedSlots?: number;
  /** Why the channel owes nothing today (mode off/shadow, agent paused, owner resource pause, every series owner-paused). */
  heldReason?:      string | null;
  /** Slots that still fit into the rest of the day (remainingCapacity). */
  capacityLeft:     number;
  published:        number;
  plannedAhead:     number;
  /** The target stored earlier today, if any: capacity never lowers it below this later in the day. */
  previousTarget?:  number | null;
}

export interface TargetResult { target: number; held: boolean; reason: string | null }

/**
 * The base is the card min clipped into the playbook's per_day range (the playbook wins over card defaults until spec
 * 092), minus the owner-paused series. A late start (a channel switched on at 18:00) cannot owe more than fits: the base
 * is capped by published + planned + capacity, but a cap computed later in the day never drops below the morning's
 * target, so a day that ran out of room stays visibly short instead of turning "met".
 */
export function dailyTarget(i: TargetInput): TargetResult {
  if (i.heldReason) return { target: 0, held: true, reason: i.heldReason };
  let base = Math.max(0, Math.floor(i.cardMin));
  const pb = i.playbookPerDay;
  if (pb) base = Math.min(Math.max(base, pb.min), pb.max);
  base = Math.max(0, base - Math.max(0, Math.floor(i.ownerPausedSlots ?? 0)));
  const reachable = i.published + i.plannedAhead + Math.max(0, i.capacityLeft);
  const capped = Math.min(base, reachable);
  const prev = i.previousTarget ?? 0;
  const target = Math.max(capped, Math.min(prev, base));
  return { target, held: false, reason: target < base ? `only ${target} of ${base} fit into the rest of the day` : null };
}

export interface StateInput {
  target:        number;
  held:          boolean;
  heldReason?:   string | null;
  published:     number;
  plannedAhead:  number;
  capacityLeft:  number;
  /** A replacement slot or recovery run started in the last hour is still open. */
  recovering:    boolean;
  /** The recovery ladder has no rung left for today. */
  ladderExhausted: boolean;
  lastPostAt:    Date | null;
  /** When the channel became active (created / switched live): a channel that never posted is dark only after this. */
  activeSince:   Date | null;
  darkHours:     number;
  now:           Date;
}

export interface StateResult { state: SloState; reason: string | null; darkSince: Date | null }

const H = 3_600_000;

/**
 * Precedence: held → dark → met → recovering → on_track → starved → behind. `dark` wins over the day's counts: a channel
 * with no post for SLO_DARK_HOURS is dark even when today's slots look planned.
 */
export function sloState(i: StateInput): StateResult {
  if (i.held) return { state: 'held', reason: i.heldReason ?? 'held', darkSince: null };
  const since = i.lastPostAt ?? i.activeSince;
  if (since && i.darkHours > 0 && i.now.getTime() - since.getTime() >= i.darkHours * H && i.published === 0) {
    const h = Math.floor((i.now.getTime() - since.getTime()) / H);
    return { state: 'dark', reason: i.lastPostAt ? `no post for ${h} h` : `no post since it became active ${h} h ago`, darkSince: new Date(since.getTime() + i.darkHours * H) };
  }
  if (i.published >= i.target) return { state: 'met', reason: null, darkSince: null };
  if (i.recovering) return { state: 'recovering', reason: 'a replacement or recovery run is in progress', darkSince: null };
  if (i.published + i.plannedAhead >= i.target) return { state: 'on_track', reason: null, darkSince: null };
  const short = i.target - i.published - i.plannedAhead;
  if (i.ladderExhausted) return { state: 'starved', reason: `${short} post(s) short and no recovery rung left today`, darkSince: null };
  return {
    state: 'behind',
    reason: i.capacityLeft > 0 ? `${short} post(s) short` : `${short} post(s) short and the day has no room left`,
    darkSince: null,
  };
}
