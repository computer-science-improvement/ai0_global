// Spec 078 B1: the pure logic of Today (/app). No React, so node tests cover it (today.test.ts).
//
//   header      greeting by the Kyiv hour, the eyebrow ("Wed, 28 Oct · Kyiv 21:51"), the "N things need you" headline
//   needs you   which notes are shown, in which order, and how the headline counts

import { KYIV_TZ, formatIn, zonedParts } from './zoned-time';

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
