// Pure layout of the Plan tab timeline (spec 024 FR-011): the axis is the
// network (anchor) zone's plan day, positions are instants relative to that
// day's 00:00 — never the browser's getHours() — and each resource keeps its
// own zone for its labels.

import { KYIV_TZ, formatIn, minutesFromDayStart, zoneOr } from './zoned-time';

export interface TimelineResource { ref: string; timezone?: string | null }

/** A lane's zone: the resource's own (Telegram: the card's), else the anchor's. */
export function laneZone(ref: string, resources: TimelineResource[] | undefined, anchorTz: string): string {
  const r = resources?.find((x) => x.ref === ref);
  return zoneOr(r?.timezone ?? null, zoneOr(anchorTz, KYIV_TZ));
}

/** The anchor's zone: its Telegram resource's zone (the card), else Kyiv. */
export function anchorZone(anchor: string | null | undefined, resources: TimelineResource[] | undefined): string {
  if (!anchor) return KYIV_TZ;
  const r = resources?.find((x) => x.ref === `telegram:${anchor}`);
  return zoneOr(r?.timezone ?? null, KYIV_TZ);
}

/** Minutes of a slot from the plan day's 00:00 in the anchor zone (a resource behind the anchor can pass 24:00). */
export function slotMinutes(at: string, day: string, anchorTz: string): number {
  return minutesFromDayStart(at, day, anchorTz);
}

/** The visible hour range: one hour of padding, at least 8 hours, within 0…36. */
export function axisHours(minutes: number[]): { start: number; end: number } {
  if (!minutes.length) return { start: 8, end: 16 };
  let start = Math.max(0, Math.floor(Math.min(...minutes) / 60) - 1);
  let end = Math.min(36, Math.ceil((Math.max(...minutes) + 1) / 60) + 1);
  if (end - start < 8) {
    const padH = 8 - (end - start);
    start = Math.max(0, start - Math.floor(padH / 2));
    end = Math.min(36, Math.max(end, start + 8));
  }
  return { start, end };
}

/** "09", or "02" for 26 (the next day). */
export const axisLabel = (h: number) => String(((h % 24) + 24) % 24).padStart(2, '0');

/** Greedy row packing: a pill goes on the first row where it does not overlap. Returns each pill's row and the row count. */
export function packRows(lefts: number[], width: number, gap = 4): { rows: number[]; count: number } {
  const ends: number[] = [];
  const rows = lefts.map((left) => {
    let row = ends.findIndex((right) => left >= right + gap);
    if (row === -1) { row = ends.length; ends.push(0); }
    ends[row] = left + width;
    return row;
  });
  return { rows, count: Math.max(1, ends.length) };
}

/** The pill's own time (resource zone) and, when it differs, the owner's Kyiv time. */
export function pillTimes(at: string, tz: string): { local: string; kyiv: string | null } {
  const local = formatIn(at, tz);
  const kyiv = formatIn(at, KYIV_TZ);
  return { local, kyiv: kyiv === local ? null : kyiv };
}

/** Source → derived pairs of a plan (both slots present). */
export function connectors<T extends { id: string; derivedFrom?: string | null }>(slots: T[]): Array<{ from: T; to: T }> {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const out: Array<{ from: T; to: T }> = [];
  for (const s of slots) {
    const src = s.derivedFrom ? byId.get(s.derivedFrom) : undefined;
    if (src) out.push({ from: src, to: s });
  }
  return out;
}

/** The treatment letter on a pill (U / D / A). */
export const TREATMENT_LETTER = { unique: 'U', duplicate: 'D', adapt: 'A' } as const;
