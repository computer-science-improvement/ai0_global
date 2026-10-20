import type { MapSnapshot, UnitState } from '../api/map';
import { alertTotal, isWorking, roadKey } from './map-state';

// Spec 056 FR-004: what changed between two snapshots, by stable ids. Pure, so it is tested without a browser.
// The first snapshot never animates (there is nothing to compare it with), and an event older than a couple of
// minutes does not animate either (a tab that was in the background must not replay the last ten minutes at once).

export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 30_000;
/** An event older than this (against the snapshot's own clock) is shown in the feed but not played on the map. */
export const FX_MAX_AGE_MS = 120_000;
/** A diff never produces more effects than this, however much happened. */
export const FX_MAX = 16;
/** Every effect is gone after this long (spec: each animation is under 1.2 s). */
export const FX_LIFE_MS = 1_200;
/** How long a new feed line stays highlighted. */
export const FRESH_MS = 4_000;

/** 5 s while any unit works, 30 s otherwise, and nothing while the tab is hidden. */
export function pollInterval(snap: Pick<MapSnapshot, 'units'> | undefined, hidden = false): number | false {
  if (hidden) return false;
  return snap?.units.some((u) => isWorking(u.state)) ? FAST_POLL_MS : SLOW_POLL_MS;
}

export type MapFx =
  /** The ring changes colour with a short pulse. */
  | { id: string; kind: 'pulse'; unitId: string; to: UnitState }
  /** A pen spark: the unit started writing. */
  | { id: string; kind: 'spark'; unitId: string }
  /** A paper plane flies from the unit to its building: it started publishing. */
  | { id: string; kind: 'plane'; unitId: string; ref: string }
  /** A flare over the building and a "+N post" floater. */
  | { id: string; kind: 'flare'; ref: string; count: number }
  /** A dot travels along a promo road. */
  | { id: string; kind: 'promo'; road: string }
  /** The unit shakes once. */
  | { id: string; kind: 'shake'; unitId: string }
  /** A new alert: a burst on the beacon (`ref` null when it belongs to no building), and the counter bumps. */
  | { id: string; kind: 'alert'; ref: string | null; alertKind: string };

export interface MapDiff {
  fx: MapFx[];
  /** Every event id that was not in the previous snapshot (the feed highlights them). */
  freshIds: string[];
  /** The number of things that wait for the owner went up. */
  alertBump: boolean;
}

export const EMPTY_DIFF: MapDiff = { fx: [], freshIds: [], alertBump: false };

const alertKey = (a: { kind: string; ref: string | null; agent: string | null }) => `${a.kind}|${a.ref ?? ''}|${a.agent ?? ''}`;

export function diffSnapshots(prev: MapSnapshot | null | undefined, next: MapSnapshot): MapDiff {
  if (!prev || prev === next) return EMPTY_DIFF;
  const stamp = next.generatedAt;
  const fx: MapFx[] = [];
  const shaken = new Set<string>();
  // A long gap between two snapshots (the tab was in the background): what happened in between is not replayed.
  const gap = new Date(next.generatedAt).getTime() - new Date(prev.generatedAt).getTime();
  const replay = !(gap > FX_MAX_AGE_MS);

  // ── state changes ──
  const before = new Map(prev.units.map((u) => [u.id, u]));
  for (const u of next.units) {
    const was = before.get(u.id);
    if (!replay || !was || was.state === u.state) continue;
    fx.push({ id: `pulse:${u.id}:${stamp}`, kind: 'pulse', unitId: u.id, to: u.state });
    if (u.state === 'writing') fx.push({ id: `spark:${u.id}:${stamp}`, kind: 'spark', unitId: u.id });
    if (u.state === 'publishing' && u.homeRef) fx.push({ id: `plane:${u.id}:${stamp}`, kind: 'plane', unitId: u.id, ref: u.homeRef });
    if (u.state === 'error' && !shaken.has(u.id)) { shaken.add(u.id); fx.push({ id: `shake:${u.id}:${stamp}`, kind: 'shake', unitId: u.id }); }
  }

  // ── new events ──
  const seen = new Set(prev.events.map((e) => e.id));
  const fresh = next.events.filter((e) => !seen.has(e.id));
  const handles = new Map(next.units.map((u) => [u.handle, u.id]));
  const clock = new Date(next.generatedAt).getTime();
  const posts = new Map<string, number>();
  const roads = new Set<string>();
  for (const e of fresh) {
    if (!replay || (Number.isFinite(clock) && clock - new Date(e.at).getTime() > FX_MAX_AGE_MS)) continue;
    if (e.kind === 'post_published' && e.ref) posts.set(e.ref, (posts.get(e.ref) ?? 0) + 1);
    else if (e.kind === 'promo' && e.ref && e.toRef) {
      const key = roadKey({ from: e.ref, to: e.toRef, kind: 'promo' });
      if (!roads.has(key)) { roads.add(key); fx.push({ id: `promo:${key}:${stamp}`, kind: 'promo', road: key }); }
    } else if ((e.kind === 'run_failed' || e.kind === 'post_failed') && e.agent) {
      const unitId = handles.get(e.agent);
      if (unitId && !shaken.has(unitId)) { shaken.add(unitId); fx.push({ id: `shake:${unitId}:${stamp}`, kind: 'shake', unitId }); }
    }
  }
  for (const [ref, count] of posts) fx.push({ id: `flare:${ref}:${stamp}`, kind: 'flare', ref, count });

  // ── new alerts ──
  const had = new Map(prev.alerts.map((a) => [alertKey(a), a.count]));
  for (const a of next.alerts) {
    if (a.count > (had.get(alertKey(a)) ?? 0)) fx.push({ id: `alert:${alertKey(a)}:${stamp}`, kind: 'alert', ref: a.ref, alertKind: a.kind });
  }

  return {
    fx: fx.slice(0, FX_MAX),
    freshIds: fresh.map((e) => e.id),
    alertBump: alertTotal(next.alerts) > alertTotal(prev.alerts),
  };
}

/** The effects that belong to one unit / building / road, for the layers that draw them. */
export const fxForUnit = (fx: readonly MapFx[], id: string): MapFx[] => fx.filter((f) => 'unitId' in f && f.unitId === id);
export const fxForBuilding = (fx: readonly MapFx[], ref: string): MapFx[] =>
  fx.filter((f) => (f.kind === 'flare' && f.ref === ref) || (f.kind === 'alert' && f.ref === ref));
export const fxForRoad = (fx: readonly MapFx[], key: string): MapFx[] => fx.filter((f) => f.kind === 'promo' && f.road === key);
