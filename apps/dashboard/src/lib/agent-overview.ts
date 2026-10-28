// Pure logic of the agent page (spec 078 D6, B3): what the pause banners say and how many of them to draw (B3.2); the
// Overview's counters, its "Today, step by step" list and the "How posts look" rows (B3.3). No React, node-tested
// (agent-overview.test.ts).

import type { AgentRun, FormatPrefField, FormatPrefs, SeriesPause, SeriesPauseCause } from '../api/agents';
import type { PlanSlot } from '../api/network';
import type { EditorRunStatus } from '../api/types';
import { FORMAT_LABEL, formatValue } from './format-prefs';
import { runLabel, skipReason } from './slot-plan';
import { MARK_LABEL, MARK_ORDER, slotMark, type MarkKind } from './status-tone';
import { dayIn, formatIn } from './zoned-time';

// ── pause banners ────────────────────────────────────────────────────────────

/** The cause of a paused series, in words (the owner's own pause has no streak). */
export const PAUSE_CAUSE: Record<SeriesPauseCause, string> = {
  no_material:        'No material',
  source_unreachable: 'Source unreachable',
  owner:              'Paused by you',
};

/**
 * The headline of a paused-series banner. A pause key is `series:<id>` (one series of the plan), `rule:<id>` (one fixed-slot
 * rule; its label reads "fixed slot 09:00 …") or `resource:<ref>` (the whole resource: nothing is planned).
 */
export function pauseTitle(p: { key: string; label: string }): string {
  const label = p.label.trim();
  if (p.key.startsWith('series:')) return label ? `Series “${label}” paused` : 'A series is paused';
  if (p.key.startsWith('rule:')) {
    const slot = label.replace(/^fixed slot\s*/i, '').trim();
    return slot ? `Fixed slot ${slot} paused` : 'A fixed slot is paused';
  }
  return 'Planning paused';
}

/** "No material: 3 skips in a row" — the streak is only named when there is one (the owner's pause has none). */
export function pauseSummary(p: { cause: SeriesPauseCause | string; streak: number }): string {
  const cause = PAUSE_CAUSE[p.cause as SeriesPauseCause] ?? String(p.cause);
  return p.streak > 0 ? `${cause}: ${p.streak} skip${p.streak === 1 ? '' : 's'} in a row` : cause;
}

/** What the pause means for planning, one line under the headline. */
export function pauseEffect(key: string): string {
  if (key.startsWith('series:')) return 'The planner skips it, and its planned slots are skipped at no cost, until you resume it.';
  if (key.startsWith('rule:')) return 'This fixed slot is skipped until you resume it.';
  return 'Nothing is planned here until you resume it.';
}

/** The first `max` pauses and how many are left behind a "Show all" button. */
export function capPauses<T>(items: readonly T[], showAll: boolean, max = 3): { shown: T[]; hidden: number } {
  if (showAll || items.length <= max) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, max), hidden: items.length - max };
}

// ── counters of the KPI strip ────────────────────────────────────────────────

/** The fields of a directive the advice counters read. */
export interface AdviceLike { binding: string; status: string; shadow: boolean; createdAt: string }

/**
 * "MANAGER advice · 30 d": advice the agent followed (accepted, applied or evaluated) and declined, shadow previews left out.
 * Mirrors the compliance block of the KPI digest (kpi-digest.service.ts complianceOf), computed from the directive list.
 */
export function adviceCounts(ds: readonly AdviceLike[], now: Date = new Date(), days = 30): { followed: number; declined: number } {
  const since = now.getTime() - days * 86_400_000;
  let followed = 0;
  let declined = 0;
  for (const d of ds) {
    if (d.binding !== 'advice' || d.shadow) continue;
    if (new Date(d.createdAt).getTime() < since) continue;
    if (d.status === 'accepted' || d.status === 'applied' || d.status === 'evaluated') followed += 1;
    else if (d.status === 'declined') declined += 1;
  }
  return { followed, declined };
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Under the "Daily plan" tile: when the agent plans (approval mode: the evening before). */
export function planAtLine(s: { planHour: number; approval: boolean; batchHour?: number | null; zone?: string | null }): string {
  const zone = s.zone ? ` ${s.zone}` : '';
  return s.approval ? `Plans at ${hh(s.batchHour ?? 20)}${zone}, the evening before` : `Plans daily at ${hh(s.planHour)}${zone}`;
}

// ── Today, step by step ──────────────────────────────────────────────────────

/** What a run's status is called on the day list (the mark's accessible name). */
export const RUN_STATUS_LABEL: Record<EditorRunStatus, string> = {
  running: 'Running', ok: 'Finished', error: 'Failed', budget_exceeded: 'Stopped: over budget', max_steps: 'Stopped: out of steps',
  no_terminal: 'Ended without a result', disabled: 'Not run: switched off',
};

/** The mark of a run: `StatusMark` has no "finished" shape, so a good run is the accent check. */
export const RUN_MARK: Record<EditorRunStatus, MarkKind> = {
  running: 'running', ok: 'approved', error: 'failed', budget_exceeded: 'failed', max_steps: 'expired', no_terminal: 'expired', disabled: 'skipped',
};

export interface DayStep {
  key: string;
  at: string;
  /** "09:30" in the channel's zone. */
  time: string;
  kind: 'slot' | 'run' | 'pause';
  mark: MarkKind;
  markLabel: string;
  title: string;
  /** Why it was skipped / what failed / what it waits for. */
  note: string | null;
  /** Format, series, cost: the mono line on the right. */
  meta: string;
  link: { kind: 'slot' | 'run'; id: string } | null;
}

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Skipped by the agent — no material: nothing new" or, for an unknown error, the error itself. */
function slotNote(slot: PlanSlot, mark: MarkKind): string | null {
  if (mark === 'awaiting_approval') return 'Waiting for your approval';
  if (!['skipped', 'failed', 'expired', 'missed'].includes(mark)) return null;
  const r = skipReason(slot.error);
  if (!r) return null;
  if (r.code === 'other') return r.detail;
  return r.detail ? `${r.label} — ${r.detail}` : r.label;
}

function slotStep(s: PlanSlot, tz: string): DayStep {
  const mark = slotMark({ status: s.status, error: s.error, seriesName: s.seriesName, scheduleRuleId: s.pinned ? 'pin' : null });
  const series = s.seriesName ?? null;
  let title = s.kind === 'reserved' ? 'Reserved slot' : (s.topic || series || s.format);
  if (mark === 'missed') title = series ? `“${series}” missed` : 'A pinned post missed';
  return {
    key: `slot:${s.id}`, at: s.at, time: formatIn(s.at, tz), kind: 'slot', mark,
    markLabel: MARK_LABEL[mark], title, note: slotNote(s, mark),
    meta: [mark === 'missed' ? null : series, s.format].filter(Boolean).join(' · '),
    link: { kind: 'slot', id: s.id },
  };
}

function runStep(r: AgentRun, tz: string, planRunId: string | null | undefined, planSlots: number): DayStep {
  const planner = planRunId != null && r.id === planRunId;
  const meta = [planner ? `${planSlots} slot${planSlots === 1 ? '' : 's'}` : null, `${r.steps} step${r.steps === 1 ? '' : 's'}`, usd(r.costUsd)].filter(Boolean).join(' · ');
  return {
    key: `run:${r.id}`, at: r.startedAt, time: formatIn(r.startedAt, tz), kind: 'run', mark: RUN_MARK[r.status] ?? 'planned',
    markLabel: RUN_STATUS_LABEL[r.status] ?? r.status, title: planner ? 'Planned the day' : upper(runLabel(r.role)),
    note: r.status === 'error' || r.status === 'budget_exceeded' ? (r.error ?? null) : null, meta,
    link: { kind: 'run', id: r.id },
  };
}

function pauseStep(p: SeriesPause, tz: string): DayStep {
  return {
    key: `pause:${p.id}`, at: p.pausedAt, time: formatIn(p.pausedAt, tz), kind: 'pause', mark: 'awaiting_approval',
    markLabel: 'Paused: waiting for you to resume', title: pauseTitle(p), note: pauseSummary(p), meta: '', link: null,
  };
}

const KIND_ORDER = { slot: 0, run: 1, pause: 2 } as const;

/**
 * The agent's day as one list: the slots of today's active plan, the runs of today that are not already a slot's own run, and
 * the series paused today, sorted by time. `day` is "YYYY-MM-DD" in `tz` (the plan's date); runs and pauses outside it are dropped.
 */
export function buildSteps(i: {
  slots: readonly PlanSlot[]; runs: readonly AgentRun[]; pauses: readonly SeriesPause[];
  planRunId?: string | null; day: string; tz: string;
}): DayStep[] {
  const slotIds = new Set(i.slots.map((s) => s.id));
  const slotRuns = new Set(i.slots.map((s) => s.runId).filter((x): x is string => !!x));
  const steps: DayStep[] = [
    ...i.slots.map((s) => slotStep(s, i.tz)),
    ...i.runs
      .filter((r) => dayIn(r.startedAt, i.tz) === i.day && !(r.slotId && slotIds.has(r.slotId)) && !slotRuns.has(r.id))
      .map((r) => runStep(r, i.tz, i.planRunId, i.slots.length)),
    ...i.pauses.filter((p) => dayIn(p.pausedAt, i.tz) === i.day).map((p) => pauseStep(p, i.tz)),
  ];
  return steps.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** Where the "now" divider goes: the index of the first step after `now` (steps.length when the day is behind us). */
export function nowIndex(steps: readonly DayStep[], now: Date = new Date()): number {
  const i = steps.findIndex((s) => new Date(s.at).getTime() > now.getTime());
  return i < 0 ? steps.length : i;
}

/**
 * The rows to draw when the day is long: `size` of them, around the "now" divider (a few behind it, the rest ahead).
 * The whole list when it fits.
 */
export function stepWindow(total: number, now: number, size = 14, behind = 4): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const start = Math.max(0, Math.min(now - behind, total - size));
  return { start, end: start + size };
}

/** "3 published · 2 planned · 1 missed": the slots of the day by mark, in the legend's order; empty when there are none. */
export function daySummary(steps: readonly DayStep[]): string {
  const counts = new Map<MarkKind, number>();
  for (const s of steps) if (s.kind === 'slot') counts.set(s.mark, (counts.get(s.mark) ?? 0) + 1);
  return MARK_ORDER.filter((m) => counts.has(m)).map((m) => `${counts.get(m)} ${MARK_LABEL[m].toLowerCase()}`).join(' · ');
}

// ── How posts look ───────────────────────────────────────────────────────────

/** The four fields the Overview shows and lets the owner lock. */
export const SUMMARY_FIELDS = ['hashtags', 'links', 'emoji', 'preferred_formats'] as const satisfies readonly FormatPrefField[];

export interface FormatRow { field: FormatPrefField; label: string; value: string | null; locked: boolean }

/** One row per summary field: its label, its value in words (`null` = not set: the agent's judgement) and whether it is locked. */
export function formatRows(prefs: FormatPrefs, locks: readonly FormatPrefField[]): FormatRow[] {
  return SUMMARY_FIELDS.map((field) => ({
    field, label: FORMAT_LABEL[field],
    value: prefs[field] === undefined ? null : formatValue(field, prefs[field]),
    locked: locks.includes(field),
  }));
}

/** The locks after the owner flips one field (the others keep their order). */
export function toggleLock(locks: readonly FormatPrefField[], field: FormatPrefField): FormatPrefField[] {
  return locks.includes(field) ? locks.filter((f) => f !== field) : [...locks, field];
}

/** The panel's header line: "at most 3 changes a day · 2 locked". */
export function lockSummary(changesPerDay: number, locked: number): string {
  return `at most ${changesPerDay} change${changesPerDay === 1 ? '' : 's'} a day · ${locked} locked`;
}
