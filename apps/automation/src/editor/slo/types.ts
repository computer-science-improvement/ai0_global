/**
 * Spec 091: the contracts between the parts of the channel SLO controller, so they can be built and tested apart.
 *
 *  SloController (slo-controller.ts)   the tick: target, counts, state, replacements, dark recovery under caps (FR-010)
 *  RungPlanner   (recovery-ladder.ts)  what a replacement slot should be, by the skip cause and the rungs tried (FR-004)
 *  DarkRecovery  (dark-recovery.ts)    a forced planner run for a dark channel, evergreen fallback (FR-005)
 *  SlotInserter  (slot-inserter.ts)    puts one controller slot into the channel's active plan at a free time (FR-003)
 *
 * The controller owns SlotInserter; RungPlanner and DarkRecovery are given one and call it, never the plan tables.
 */
import type { EditorCard } from '../card';
import type { LiveSpec } from '../live/live-slot';
import type { SkipCause } from '../series-pause/skip-cause';

export const SLO_STATES = ['on_track', 'behind', 'recovering', 'starved', 'dark', 'held', 'met'] as const;
export type SloState = typeof SLO_STATES[number];

/** The rungs of the recovery ladder (FR-004), cheapest first per cause. `directive` marks a manager `task` slot (FR-006). */
export const RUNG_KINDS = ['next_material', 'lighter_format', 'widen_live', 'other_series', 'other_source', 'evergreen', 'recovery_plan', 'directive'] as const;
export type RungKind = typeof RUNG_KINDS[number];

/** What `editor_slots.slo` holds on a slot the controller inserted (migration 104). */
export interface SloSlotMark {
  /** The closed slot this one replaces (null for a dark-recovery slot). */
  replaces: string | null;
  rung:     RungKind;
  /** The skip cause that led here (null for a dark-recovery slot). */
  cause:    SkipCause | null;
  /** 1 = a replacement, 2 = a replacement of a replacement (the last one; FR-003). */
  depth:    number;
}

/** The slot a rung asks for. The inserter picks the time; everything else comes from here. */
export interface ReplacementSpec {
  format:       string;
  topic:        string;
  angle?:       string | null;
  sourceHints?: string[];
  seriesName?:  string | null;
  topicMode?:   'fixed' | 'live';
  live?:        LiveSpec | null;
  ideaId?:      string | null;
}

/** A content slot that closed without a post, as the controller hands it on (FR-003). */
export interface ClosedSlot {
  id:           string;
  channelKey:   string;
  scheduledAt:  Date;
  status:       'skipped' | 'failed';
  error:        string | null;
  format:       string;
  topic:        string;
  seriesName:   string | null;
  topicMode:    'fixed' | 'live';
  live:         LiveSpec | null;
  sourceHints:  string[];
  /** `editor_slots.slo` of the closed slot (null when the planner made it). */
  slo:          SloSlotMark | null;
}

export interface SlotInserter {
  /**
   * Insert one controller slot into the channel's active plan at the earliest free time ≥ now + SLO_REPLACEMENT_LEAD_MIN
   * that respects spacing, quiet hours and the day's end. Returns the new slot id, or null when there is no room, no
   * active plan, or the replaced slot already has a replacement (unique replaces_slot_id).
   */
  insert(card: EditorCard, spec: ReplacementSpec, mark: SloSlotMark, now: Date): Promise<string | null>;
}

export interface RungChoice { rung: RungKind; spec: ReplacementSpec }

export interface RungPlanner {
  /**
   * The cheapest rung for this closed slot that was not tried today for the channel (`tried`), or null when none is left
   * (the channel is starved). `cause` is from classifyClose; config and budget closes never reach here.
   */
  choose(card: EditorCard, closed: ClosedSlot, cause: SkipCause, tried: readonly RungKind[], now: Date): Promise<RungChoice | null>;
}

export interface DarkContext {
  darkSince:   Date;
  /** The last skip reasons of the channel, newest first (at most 5). */
  lastSkips:   string[];
  target:      number;
  /** How many recovery runs today already (the caller checks the cap first). */
  runsToday:   number;
}

export interface DarkRecoveryResult {
  /** Slots the forced planner run planned for today. */
  planned:     number;
  /** The evergreen slot inserted when the planner planned nothing (FR-005 step 3). */
  evergreenSlotId: string | null;
  /** One English line for the decision log and the dashboard. */
  summary:     string;
}

export interface DarkRecovery {
  recover(card: EditorCard, ctx: DarkContext, now: Date): Promise<DarkRecoveryResult>;
}
