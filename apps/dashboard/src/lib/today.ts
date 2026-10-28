// Spec 078 B1: the pure logic of Today (/app). No React, so node tests cover it (today.test.ts).
//
//   header      greeting by the Kyiv hour, the eyebrow ("Wed, 28 Oct · Kyiv 21:51"), the "N things need you" headline
//   needs you   which notes are shown, in which order, and how the headline counts
//   the day     lanes and markers of the timeline, the now-line, the ring's counts and arcs
//   glance      the busiest channel by budget
//   agents      the orchestrator of each channel, found in the agent tree
//   KPI         the Meta accounts that need reconnecting

import { KYIV_TZ, formatIn, minutesFromDayStart, zonedParts } from './zoned-time';
import { MARK_LABEL, MARK_ORDER, isMissed, isNotAMiss, slotMark, type MarkKind } from './status-tone';
import { packRows } from './plan-timeline';
import { skipReason } from './slot-plan';

// ── header ───────────────────────────────────────────────────────────────────

/** "Good morning" from 05:00, "Good afternoon" from 12:00, "Good evening" from 18:00 (the evening runs to the next morning). */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The greeting for the owner's clock: Kyiv time, never the browser's zone. */
export function kyivGreeting(now: Date): string {
  return greetingFor(zonedParts(now, KYIV_TZ).hour);
}

/** "Wed, 28 Oct · Kyiv 21:51" (the page header's mono overline upper-cases it). */
export function kyivEyebrow(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: KYIV_TZ, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')}, ${get('day')} ${get('month')} · Kyiv ${formatIn(now, KYIV_TZ)}`;
}

/** "Nothing needs you." / "1 thing needs you." / "4 things need you." */
export function needsHeadline(n: number): string {
  if (n <= 0) return 'Nothing needs you.';
  return n === 1 ? '1 thing needs you.' : `${n} things need you.`;
}

// ── needs you ────────────────────────────────────────────────────────────────

export type NoteSeverity = 'critical' | 'action' | 'info';

/** The fields of an Inbox note this logic reads (an `InboxItem` fits). */
export interface NoteLike {
  id:        number;
  severity:  NoteSeverity;
  readAt:    string | null;
  createdAt: string;
}

const RANK: Record<NoteSeverity, number> = { critical: 0, action: 1, info: 2 };
const rank = (s: string): number => RANK[s as NoteSeverity] ?? RANK.info;

/** Critical before action before FYI, newest first inside a severity. Does not mutate. */
export function sortNotes<T extends NoteLike>(notes: ReadonlyArray<T>): T[] {
  return [...notes].sort((a, b) => rank(a.severity) - rank(b.severity) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
}

/** The notes that need the owner: unread, critical or action (FYI notes are news, not decisions), not dismissed on this page yet. */
export function openNotes<T extends NoteLike>(notes: ReadonlyArray<T> | null | undefined, hidden: ReadonlySet<number> = new Set()): T[] {
  return sortNotes((notes ?? []).filter((n) => !n.readAt && !hidden.has(n.id) && (n.severity === 'critical' || n.severity === 'action')));
}

/** How many notes Today lists (the rest is behind "Open inbox"). */
export const NEEDS_ROWS = 4;

export interface NeedsSummary {
  /** Unread critical notes. */
  critical: number;
  /** Unread action notes + posts to approve + cards waiting in a chat: what the owner has to decide. */
  toAct:    number;
  /** `critical + toAct`: the headline's N. Directives arrive as notes, so they are not counted again. */
  total:    number;
}

export function needsSummary(input: {
  notes:     ReadonlyArray<NoteLike> | null | undefined;
  approvals: number;
  chatCards: number;
  hidden?:   ReadonlySet<number>;
}): NeedsSummary {
  const open = openNotes(input.notes, input.hidden);
  const critical = open.filter((n) => n.severity === 'critical').length;
  const toAct = open.length - critical + Math.max(0, input.approvals) + Math.max(0, input.chatCards);
  return { critical, toAct, total: critical + toAct };
}

/** "Open inbox · N": every unread note (FYI too) plus the posts to approve, the same sum as the menu's Inbox counter. */
export function inboxLinkCount(notes: ReadonlyArray<NoteLike> | null | undefined, approvals: number, hidden: ReadonlySet<number> = new Set()): number {
  return (notes ?? []).filter((n) => !n.readAt && !hidden.has(n.id)).length + Math.max(0, approvals);
}

/** A toast-sized title: one line, cut at `max` characters. */
export function shorten(text: string, max = 64): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ── the day: lanes, markers, the ring ────────────────────────────────────────

/** The timeline's fixed axis: 06:00 to 24:00 in Kyiv time. */
export const AXIS_START_MIN = 6 * 60;
export const AXIS_END_MIN = 24 * 60;
/** Tick labels of the axis (hours). */
export const AXIS_HOURS: readonly number[] = [6, 9, 12, 15, 18, 21, 24];
/** Two markers closer than this many minutes would overlap on the narrowest axis (about 0.54px a minute at 760px, for a 16px mark): the later one goes on the next row. */
export const MARKER_SPAN_MIN = 36;

/** Position on the axis in percent, clamped to the axis (a slot before 06:00 sits on the left edge, one after 24:00 on the right). */
export function axisPct(minutes: number): number {
  const p = ((minutes - AXIS_START_MIN) / (AXIS_END_MIN - AXIS_START_MIN)) * 100;
  return Math.round(Math.min(100, Math.max(0, p)) * 100) / 100;
}

/** The slot fields the day view reads (an `EditorSlot` fits). */
export interface DaySlot {
  id:              string;
  channelKey:      string;
  scheduledAt:     string;
  kind?:           'content' | 'reserved';
  status:          string;
  topic:           string;
  error:           string | null;
  seriesName?:     string | null;
  scheduleRuleId?: string | null;
  resourceRef?:    string | null;
}

/** The plan fields the day view reads (an `EditorPlan` fits). */
export interface DayPlan {
  channelKey: string;
  status:     string;
  slots:      ReadonlyArray<DaySlot>;
}

/** Slots of the active plans only: a replan leaves the old plan `superseded`, and its skipped slots must not show. */
export function activeSlots<S extends DaySlot, P extends { status: string; slots: ReadonlyArray<S> }>(plans: ReadonlyArray<P> | null | undefined): S[] {
  return (plans ?? []).filter((p) => p.status === 'active').flatMap((p) => p.slots);
}

/**
 * The Telegram lane: slots with no `resourceRef`. A network anchor's plan also holds the copies for Instagram, Facebook and
 * Threads (they carry a `resourceRef`); those are not the agent's own Telegram posts and are counted apart.
 */
export function telegramSlots<S extends DaySlot, P extends { status: string; slots: ReadonlyArray<S> }>(plans: ReadonlyArray<P> | null | undefined): S[] {
  return activeSlots<S, P>(plans).filter((s) => !s.resourceRef);
}

export function otherPlatformCount<S extends DaySlot, P extends { status: string; slots: ReadonlyArray<S> }>(plans: ReadonlyArray<P> | null | undefined): number {
  return activeSlots<S, P>(plans).filter((s) => !!s.resourceRef).length;
}

export type DayBucket = 'published' | 'shadowed' | 'skipped' | 'missed' | 'failed' | 'ahead';

type BucketInput = { status: string; error?: string | null; seriesName?: string | null; scheduleRuleId?: string | null };

/** Where a slot counts in the ring. `missed` is the computed state (a series or pin that did not go out and was nobody's decision). */
export function bucketOf(slot: BucketInput): DayBucket {
  if (isMissed(slot)) return 'missed';
  switch (slot.status) {
    case 'published': return 'published';
    case 'shadowed':  return 'shadowed';
    case 'skipped':
    case 'expired':   return 'skipped';
    case 'failed':    return 'failed';
    default:          return 'ahead';   // planned, running, awaiting_approval, approved
  }
}

export interface DaySummary {
  /** Slots counted in the ring (a skip the system chose, such as a replan, is not one). */
  total:  number;
  /** Published plus shadowed: nothing left to do for the slot. */
  done:   number;
  counts: Record<DayBucket, number>;
}

/** Counts of the day for the ring. A slot the system skipped itself (superseded plan, mode change, cancelled draft, paused series) never counts. */
export function summarizeDay(slots: ReadonlyArray<BucketInput>): DaySummary {
  const counts: Record<DayBucket, number> = { published: 0, shadowed: 0, skipped: 0, missed: 0, failed: 0, ahead: 0 };
  let total = 0;
  for (const s of slots) {
    if ((s.status === 'skipped' || s.status === 'expired') && isNotAMiss(s.error)) continue;
    counts[bucketOf(s)]++;
    total++;
  }
  return { total, done: counts.published + counts.shadowed, counts };
}

export interface RingArc {
  key:    string;
  /** Length of the arc, and the rest of the circle, in the circle's own units (stroke-dasharray = `${dash} ${gap}`). */
  dash:   number;
  gap:    number;
  /** Where the arc starts: the sum of the arcs before it (stroke-dashoffset = `-offset`). */
  offset: number;
}

/** Arcs of a ring: each part's share of `total` around `circumference`; a part with no value draws nothing, the rest is the track. */
export function ringArcs(parts: ReadonlyArray<{ key: string; value: number }>, total: number, circumference: number): RingArc[] {
  if (!(total > 0)) return [];
  const arcs: RingArc[] = [];
  let offset = 0;
  for (const p of parts) {
    if (!(p.value > 0)) continue;
    const dash = Math.min(circumference - offset, (p.value / total) * circumference);
    if (dash <= 0) break;
    arcs.push({ key: p.key, dash, gap: circumference - dash, offset });
    offset += dash;
  }
  return arcs;
}

export interface Marker {
  id:      string;
  mark:    MarkKind;
  minutes: number;
  pct:     number;
  /** Sub-row inside the lane (0 = the first): markers closer than `MARKER_SPAN_MIN` stack. */
  row:     number;
  /** "HH:MM" in the axis zone. */
  time:    string;
  /** Tooltip and accessible name: "12:00 · Missed · Daily fact · Rejected by the critic". */
  label:   string;
  /** The slot is outside 06:00-24:00 and sits on the edge. */
  clamped: boolean;
}

export interface Lane {
  channelKey: string;
  markers:    Marker[];
  /** Sub-rows the lane needs (at least 1). */
  rows:       number;
}

function markerLabel(slot: DaySlot, mark: MarkKind, time: string, clamped: boolean): string {
  const title = shorten(slot.seriesName?.trim() || slot.topic || '', 80);
  const parts: string[] = [time, MARK_LABEL[mark]];
  if (title) parts.push(slot.kind === 'reserved' && !slot.seriesName ? `Reserved: ${title}` : title);
  else if (slot.kind === 'reserved') parts.push('Reserved post');
  // Why a slot did not go out (the system's own words stay on the slot page).
  if (slot.error && (slot.status === 'skipped' || slot.status === 'failed' || slot.status === 'expired')) {
    const why = skipReason(slot.error);
    if (why) parts.push(why.code === 'other' ? shorten(why.detail, 60) : why.label);
  }
  if (clamped) parts.push('outside the 06-24 axis');
  return parts.join(' · ');
}

/** Markers of one lane, sorted by time, with their sub-rows. */
export function laneMarkers(slots: ReadonlyArray<DaySlot>, day: string, tz: string = KYIV_TZ): { markers: Marker[]; rows: number } {
  const placed = slots
    .map((s) => {
      const minutes = minutesFromDayStart(s.scheduledAt, day, tz);
      return { slot: s, minutes, clamped: minutes < AXIS_START_MIN || minutes > AXIS_END_MIN, mark: slotMark(s), time: formatIn(s.scheduledAt, tz) };
    })
    .sort((a, b) => a.minutes - b.minutes || (a.slot.id < b.slot.id ? -1 : a.slot.id > b.slot.id ? 1 : 0));
  const lefts = placed.map((p) => Math.min(AXIS_END_MIN, Math.max(AXIS_START_MIN, p.minutes)));
  const { rows, count } = packRows(lefts, MARKER_SPAN_MIN, 0);
  const markers = placed.map((p, i): Marker => ({
    id: p.slot.id, mark: p.mark, minutes: p.minutes, pct: axisPct(p.minutes), row: rows[i], time: p.time,
    label: markerLabel(p.slot, p.mark, p.time, p.clamped), clamped: p.clamped,
  }));
  return { markers, rows: count };
}

/**
 * The lanes of the schedule: one per channel, in the channels' order, then any channel that has a plan but no card.
 * A lane shows the Telegram posts of the channel's active plan. A channel that is not off keeps an empty lane (the planner
 * has not written its day yet); an off channel with nothing planned has no lane.
 */
export function buildLanes<S extends DaySlot, P extends { status: string; slots: ReadonlyArray<S> }>(input: {
  plans:    ReadonlyArray<P> | null | undefined;
  channels: ReadonlyArray<{ channelKey: string; mode?: string }> | null | undefined;
  day:      string;
  tz?:      string;
}): Lane[] {
  const byChannel = new Map<string, S[]>();
  for (const s of telegramSlots<S, P>(input.plans)) byChannel.set(s.channelKey, [...(byChannel.get(s.channelKey) ?? []), s]);
  const known = (input.channels ?? []).map((c) => ({ key: c.channelKey, off: c.mode === 'off' }));
  const extra = [...byChannel.keys()].filter((k) => !known.some((c) => c.key === k)).map((k) => ({ key: k, off: false }));
  const lanes: Lane[] = [];
  for (const { key, off } of [...known, ...extra]) {
    const { markers, rows } = laneMarkers(byChannel.get(key) ?? [], input.day, input.tz);
    if (markers.length === 0 && off) continue;
    lanes.push({ channelKey: key, markers, rows });
  }
  return lanes;
}

/** The marks that occur on the timeline, in legend order. */
export function legendMarks(lanes: ReadonlyArray<Lane>): MarkKind[] {
  const present = new Set<MarkKind>();
  for (const l of lanes) for (const m of l.markers) present.add(m.mark);
  return MARK_ORDER.filter((k) => present.has(k));
}

/** The now-line: its position on the axis, or null when now is outside 06:00-24:00 of the plan day (or the day is another one). */
export function nowLine(now: Date, day: string, tz: string = KYIV_TZ): { pct: number; minutes: number; label: string } | null {
  const minutes = minutesFromDayStart(now, day, tz);
  if (minutes < AXIS_START_MIN || minutes > AXIS_END_MIN) return null;
  return { pct: axisPct(minutes), minutes, label: `now ${formatIn(now, tz)}` };
}

/** How much of the axis is already past, in percent: 0 before the axis starts, 100 once the plan day is over. */
export function pastPct(now: Date, day: string, tz: string = KYIV_TZ): number {
  return axisPct(minutesFromDayStart(now, day, tz));
}

/** Height of a lane in px: 44 for one row, 20 more for each extra row. */
export function laneHeight(rows: number): number {
  return 44 + Math.max(0, rows - 1) * 20;
}

// ── the glance ────────────────────────────────────────────────────────────────

export interface ChannelSpendLike {
  channelKey:     string;
  title?:         string | null;
  dailyBudgetUsd: number | null;
  today:          { spendUsd: number };
}

export interface Busiest {
  channelKey: string;
  title:      string | null;
  spentUsd:   number;
  capUsd:     number | null;
  /** Spend as a percent of the cap (not clamped), null without a cap. */
  pct:        number | null;
}

/**
 * The channel that has used the most of its daily budget. Channels with a cap compare by share of the cap; when none has
 * a cap the biggest spender wins. Nothing spent today: null.
 */
export function busiestChannel(channels: ReadonlyArray<ChannelSpendLike> | null | undefined): Busiest | null {
  const spenders = (channels ?? []).filter((c) => c.today.spendUsd > 0);
  const share = (c: ChannelSpendLike) => c.today.spendUsd / (c.dailyBudgetUsd as number);
  const capped = spenders.filter((c) => (c.dailyBudgetUsd ?? 0) > 0);
  const pick = (c: ChannelSpendLike): Busiest => {
    const cap = (c.dailyBudgetUsd ?? 0) > 0 ? c.dailyBudgetUsd : null;
    return { channelKey: c.channelKey, title: c.title ?? null, spentUsd: c.today.spendUsd, capUsd: cap, pct: cap ? (c.today.spendUsd / cap) * 100 : null };
  };
  if (capped.length) return pick(capped.reduce((a, b) => (share(b) > share(a) ? b : a)));
  if (spenders.length) return pick(spenders.reduce((a, b) => (b.today.spendUsd > a.today.spendUsd ? b : a)));
  return null;
}

/** Bar state of a share of a cap (the same steps as the budgets: warning from 70 %, danger from 90 %). No cap: `none`. */
export function capState(pct: number | null | undefined): 'none' | 'ok' | 'warning' | 'danger' {
  if (pct == null || !Number.isFinite(pct)) return 'none';
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warning';
  return 'ok';
}

// ── agents ────────────────────────────────────────────────────────────────────

export interface AgentNodeLike {
  kind:      string;
  scopeId:   string | null;
  children?: ReadonlyArray<AgentNodeLike>;
}

/** Orchestrators of Telegram channels by channel key (`telegram:@x` becomes `@x`), found anywhere in the agent tree. */
export function orchestratorsByChannel<T extends AgentNodeLike>(nodes: ReadonlyArray<T> | null | undefined): Map<string, T> {
  const out = new Map<string, T>();
  const walk = (list: ReadonlyArray<T>) => {
    for (const n of list) {
      if (n.kind === 'orchestrator' && n.scopeId?.startsWith('telegram:')) out.set(n.scopeId.slice('telegram:'.length), n);
      if (n.children?.length) walk(n.children as ReadonlyArray<T>);
    }
  };
  walk(nodes ?? []);
  return out;
}

// ── KPI ───────────────────────────────────────────────────────────────────────

const META_PLATFORMS: ReadonlySet<string> = new Set(['threads', 'instagram', 'facebook']);

/** Meta accounts that need the owner to reconnect them: an unmuted connection problem whose token is invalid or whose access is gone. */
export function reconnectCount(connections: ReadonlyArray<{ ref: string; state: string; muted: boolean }> | null | undefined): number {
  return (connections ?? []).filter((c) => !c.muted && (c.state === 'token_invalid' || c.state === 'no_access') && META_PLATFORMS.has(c.ref.split(':', 1)[0])).length;
}
