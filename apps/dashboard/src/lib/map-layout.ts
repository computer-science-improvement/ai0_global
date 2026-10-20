import type { InfraKind, MapInfra, MapNetwork, MapResource, MapUnit, MapPlatform } from '../api/map';
import { KIND_ORDER } from './map-state';

// Spec 056 FR-003: the deterministic layout of the network map. A pure function: the same input (in any order) gives
// the same positions, there is no force simulation, so a building never moves between two polls. World units are
// pixels at zoom 1; the origin is the top-left of the bounds.
//
//   • sections (territories) sit on a shelf-packed grid: the networks first (the one with the most resources first), then
//     one section per platform for the resources outside any network (Telegram channels, Instagram…), then — on a row of
//     their own — the connections the channels work through (Telegram bots, MTProto sessions, Telegraph accounts);
//   • in a network, the anchor (its Telegram channel) is in the middle and the other buildings on a ring around it;
//     a platform section is a plain grid; a connection section a grid of small structures;
//   • the headquarters is at the top centre and holds the system agents (and any unit whose building is missing);
//   • units stand around their home building: orchestrators in a row in front, their role children on an arc behind.

export const BUILDING_R = 30;
export const UNIT_R = 14;
/** Distance from a building's centre to the row of units in front of it (leaves room for the title). */
export const FRONT_DY = BUILDING_R + 56;
/** Radius of the arc of role children behind a building. */
export const ARC_R = BUILDING_R + 34;
const UNIT_GAP = 36;

/** Half-extents of a building with its units: the footprint a neighbour must keep clear of. */
const FOOT_X = ARC_R + UNIT_R + 6;
const FOOT_TOP = ARC_R + UNIT_R + 4;
const FOOT_BOTTOM = FRONT_DY + UNIT_R + 22;
/** Minimum distance between two neighbours on a ring. */
const RING_CHORD = 196;
const RING_MIN = 210;
const TERRITORY_PAD = 44;
const TERRITORY_HEAD = 38;
const TERRITORY_GAP = 52;
const ROW_MAX_W = 1500;
const HQ_MIN_W = 360;
const HQ_H = 156;
const HQ_GAP = 70;
const CELL_W = 2 * FOOT_X + 12;
const CELL_H = FOOT_TOP + FOOT_BOTTOM + 10;

/** A connection (bot, session, Telegraph account): a small structure, no units. */
export const STRUCT_R = 22;
const STRUCT_CELL_W = 150;
const STRUCT_CELL_H = 2 * STRUCT_R + 64;
const STRUCT_MAX_COLS = 4;

export type TerritoryKind = 'network' | 'platform' | 'infra';
/** The section of the resources of one platform that are in no network. */
export const platformSectionId = (p: MapPlatform): string => `__platform:${p}__`;
export const infraSectionId = (k: InfraKind): string => `__infra:${k}__`;

export const PLATFORM_SECTION_NAME: Record<MapPlatform, string> = {
  telegram: 'Telegram channels', instagram: 'Instagram', facebook: 'Facebook pages', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube',
};
export const INFRA_SECTION_NAME: Record<InfraKind, string> = { bot: 'Telegram bots', mtproto: 'MTProto sessions', telegraph: 'Telegraph accounts' };
const INFRA_ORDER: InfraKind[] = ['bot', 'mtproto', 'telegraph'];

export interface Rect { x: number; y: number; w: number; h: number }
export interface Territory extends Rect {
  id: string;
  name: string;
  kind: TerritoryKind;
  /** Index into the territory tint palette (stable for the order). */
  tint: number;
  /** A platform section's platform (its tint); an infra section's kind. */
  platform?: MapPlatform;
  infra?: InfraKind;
  /** Buildings, or the structures of an infra section. */
  refs: string[];
}
export interface PlacedBuilding { x: number; y: number; territory: string; anchor: boolean }
export interface PlacedStructure { x: number; y: number; territory: string }
export interface PlacedUnit { x: number; y: number; zone: 'hq' | 'front' | 'back' }

export interface MapLayout {
  bounds: Rect;
  hq: Rect;
  territories: Territory[];
  buildings: Record<string, PlacedBuilding>;
  /** Bots, sessions and Telegraph accounts by their id. */
  structures: Record<string, PlacedStructure>;
  units: Record<string, PlacedUnit>;
}

export interface LayoutInput {
  networks: Array<Pick<MapNetwork, 'id' | 'name' | 'anchorRef'>>;
  resources: Array<Pick<MapResource, 'ref' | 'groupId' | 'platform'>>;
  units: Array<Pick<MapUnit, 'id' | 'handle' | 'kind' | 'parentId' | 'homeRef'>>;
  infra?: Array<Pick<MapInfra, 'id' | 'kind'>>;
}

const PLATFORM_ORDER: MapPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube'];
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const platformIdx = (p: MapPlatform) => { const i = PLATFORM_ORDER.indexOf(p); return i < 0 ? PLATFORM_ORDER.length : i; };
const kindIdx = (k: MapUnit['kind']) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };

interface Group {
  id: string; name: string; kind: TerritoryKind; anchor: string | null; platform?: MapPlatform; infra?: InfraKind;
  members: Array<Pick<MapResource, 'ref' | 'groupId' | 'platform'>>;
}

/** Members of a group in a stable order: platform order, then ref. */
const sortMembers = (m: Group['members']) => [...m].sort((a, b) => platformIdx(a.platform) - platformIdx(b.platform) || cmp(a.ref, b.ref));

/** The positions of a group's buildings relative to the group's own top-left, and the group's size. */
function arrange(g: Group): { w: number; h: number; at: Array<{ ref: string; x: number; y: number; anchor: boolean }> } {
  const members = sortMembers(g.members);
  const at: Array<{ ref: string; x: number; y: number; anchor: boolean }> = [];
  if (g.kind === 'infra') {
    const ids = g.members.map((m) => m.ref).sort(cmp);
    const cols = Math.max(1, Math.min(STRUCT_MAX_COLS, ids.length));
    const rows = Math.ceil(ids.length / cols);
    ids.forEach((ref, i) => at.push({ ref, x: TERRITORY_PAD + (i % cols) * STRUCT_CELL_W + STRUCT_CELL_W / 2, y: TERRITORY_HEAD + TERRITORY_PAD + Math.floor(i / cols) * STRUCT_CELL_H + STRUCT_R + 6, anchor: false }));
    return { w: Math.max(260, cols * STRUCT_CELL_W + 2 * TERRITORY_PAD), h: TERRITORY_HEAD + 2 * TERRITORY_PAD + rows * STRUCT_CELL_H - 10, at };
  }
  if (g.kind === 'platform') {
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const rows = Math.ceil(members.length / cols);
    members.forEach((m, i) => at.push({ ref: m.ref, x: TERRITORY_PAD + (i % cols) * CELL_W + CELL_W / 2, y: TERRITORY_HEAD + TERRITORY_PAD + Math.floor(i / cols) * CELL_H + FOOT_TOP, anchor: false }));
    return { w: Math.max(2 * FOOT_X, cols * CELL_W) + 2 * TERRITORY_PAD, h: TERRITORY_HEAD + 2 * TERRITORY_PAD + rows * CELL_H, at };
  }
  // The centre: the anchor, else the first member.
  const centre = members.find((m) => m.ref === g.anchor) ?? members[0];
  const ring = members.filter((m) => m !== centre);
  const m = ring.length;
  const radius = m === 0 ? 0 : Math.max(RING_MIN, m > 1 ? RING_CHORD / (2 * Math.sin(Math.PI / m)) : 0);
  const w = 2 * (radius + FOOT_X + TERRITORY_PAD);
  const cx = w / 2;
  const cy = TERRITORY_HEAD + TERRITORY_PAD + radius + FOOT_TOP;
  const h = cy + radius + FOOT_BOTTOM + TERRITORY_PAD;
  at.push({ ref: centre.ref, x: cx, y: cy, anchor: true });
  // Start so that two buildings sit left/right, three form a triangle with the point down-up…
  const start = -90 + 180 / Math.max(m, 1);
  ring.forEach((r, i) => {
    const a = ((start + (360 / m) * i) * Math.PI) / 180;
    at.push({ ref: r.ref, x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a), anchor: false });
  });
  return { w, h, at };
}

export function layoutMap(input: LayoutInput): MapLayout {
  // ── group the resources ──
  const known = new Set(input.networks.map((n) => n.id));
  const groups = new Map<string, Group>();
  for (const n of input.networks) groups.set(n.id, { id: n.id, name: n.name, kind: 'network', anchor: n.anchorRef, members: [] });
  const solo = new Map<MapPlatform, Group>();
  for (const r of input.resources) {
    if (r.groupId && known.has(r.groupId)) { groups.get(r.groupId)!.members.push(r); continue; }
    let g = solo.get(r.platform);
    if (!g) solo.set(r.platform, g = { id: platformSectionId(r.platform), name: PLATFORM_SECTION_NAME[r.platform] ?? r.platform, kind: 'platform', anchor: null, platform: r.platform, members: [] });
    g.members.push(r);
  }
  const infra = new Map<InfraKind, Group>();
  for (const i of input.infra ?? []) {
    let g = infra.get(i.kind);
    if (!g) infra.set(i.kind, g = { id: infraSectionId(i.kind), name: INFRA_SECTION_NAME[i.kind] ?? i.kind, kind: 'infra', anchor: null, infra: i.kind, members: [] });
    g.members.push({ ref: i.id, groupId: null, platform: 'telegram' });
  }

  const ordered: Group[] = [
    ...[...groups.values()].filter((g) => g.members.length > 0)
      .sort((a, b) => b.members.length - a.members.length || cmp(a.name, b.name) || cmp(a.id, b.id)),
    ...[...solo.values()].sort((a, b) => platformIdx(a.platform!) - platformIdx(b.platform!)),
    ...INFRA_ORDER.map((k) => infra.get(k)).filter((g): g is Group => !!g),
  ];

  // ── shelf-pack the territories (the connections start a row of their own) ──
  const arranged = ordered.map((g) => ({ g, ...arrange(g) }));
  const rows: Array<typeof arranged> = [];
  let rowW = 0;
  for (const t of arranged) {
    const firstInfra = t.g.kind === 'infra' && rows.length > 0 && rows[rows.length - 1].every((x) => x.g.kind !== 'infra');
    if (!rows.length || firstInfra || (rowW > 0 && rowW + TERRITORY_GAP + t.w > ROW_MAX_W)) { rows.push([]); rowW = 0; }
    rows[rows.length - 1].push(t);
    rowW += (rowW > 0 ? TERRITORY_GAP : 0) + t.w;
  }
  const widths = rows.map((r) => r.reduce((s, t, i) => s + t.w + (i ? TERRITORY_GAP : 0), 0));
  const hqW = HQ_MIN_W;
  const totalW = Math.max(hqW, ...widths, 0);

  const territories: Territory[] = [];
  const buildings: Record<string, PlacedBuilding> = {};
  const structures: Record<string, PlacedStructure> = {};
  let y = HQ_H + HQ_GAP;
  rows.forEach((row, ri) => {
    let x = (totalW - widths[ri]) / 2;
    const rowH = Math.max(...row.map((t) => t.h));
    for (const t of row) {
      territories.push({
        id: t.g.id, name: t.g.name, kind: t.g.kind, x, y, w: t.w, h: t.h, tint: territories.length, refs: t.at.map((a) => a.ref),
        ...(t.g.platform && t.g.kind === 'platform' ? { platform: t.g.platform } : {}), ...(t.g.infra ? { infra: t.g.infra } : {}),
      });
      for (const a of t.at) {
        if (t.g.kind === 'infra') structures[a.ref] = { x: x + a.x, y: y + a.y, territory: t.g.id };
        else buildings[a.ref] = { x: x + a.x, y: y + a.y, territory: t.g.id, anchor: a.anchor };
      }
      x += t.w + TERRITORY_GAP;
    }
    y += rowH + TERRITORY_GAP;
  });

  const hq: Rect = { x: (totalW - hqW) / 2, y: 0, w: hqW, h: HQ_H };

  // ── units ──
  const units: Record<string, PlacedUnit> = {};
  const byId = new Map(input.units.map((u) => [u.id, u]));
  const hqUnits = input.units.filter((u) => !u.homeRef || !buildings[u.homeRef])
    .sort((a, b) => kindIdx(a.kind) - kindIdx(b.kind) || cmp(a.handle, b.handle));
  const perRow = Math.max(1, Math.floor((hqW - 40) / UNIT_GAP));
  hqUnits.forEach((u, i) => {
    const rowIdx = Math.floor(i / perRow);
    const inRow = Math.min(perRow, hqUnits.length - rowIdx * perRow);
    units[u.id] = { x: hq.x + hq.w / 2 + ((i % perRow) - (inRow - 1) / 2) * UNIT_GAP, y: hq.y + 84 + rowIdx * UNIT_GAP, zone: 'hq' };
  });

  const byHome = new Map<string, LayoutInput['units']>();
  for (const u of input.units) {
    if (!u.homeRef || !buildings[u.homeRef]) continue;
    byHome.set(u.homeRef, [...(byHome.get(u.homeRef) ?? []), u]);
  }
  for (const [ref, list] of byHome) {
    const b = buildings[ref];
    const here = new Set(list.map((u) => u.id));
    // Front: units that are not role children of a unit standing here (orchestrators first).
    const front = list.filter((u) => !u.parentId || !here.has(u.parentId) || !byId.has(u.parentId))
      .sort((a, c) => kindIdx(a.kind) - kindIdx(c.kind) || cmp(a.handle, c.handle));
    const frontIdx = new Map(front.map((u, i) => [u.id, i]));
    const back = list.filter((u) => !front.includes(u))
      .sort((a, c) => (frontIdx.get(a.parentId!) ?? 0) - (frontIdx.get(c.parentId!) ?? 0) || kindIdx(a.kind) - kindIdx(c.kind) || cmp(a.handle, c.handle));
    front.forEach((u, i) => { units[u.id] = { x: b.x + (i - (front.length - 1) / 2) * UNIT_GAP, y: b.y + FRONT_DY, zone: 'front' }; });
    // Back: an arc over the top, a second arc outside it when there are many.
    const PER_ARC = 6;
    for (let start = 0, ring = 0; start < back.length; start += PER_ARC, ring++) {
      const slice = back.slice(start, start + PER_ARC);
      const r = ARC_R + ring * (UNIT_R * 2 + 4);
      slice.forEach((u, i) => {
        const a = slice.length === 1 ? -90 : -160 + (140 / (slice.length - 1)) * i;
        units[u.id] = { x: b.x + r * Math.cos((a * Math.PI) / 180), y: b.y + r * Math.sin((a * Math.PI) / 180), zone: 'back' };
      });
    }
  }

  const bounds = boundsOf(hq, territories);
  return { bounds, hq, territories, buildings, structures, units };
}

function boundsOf(hq: Rect, territories: Territory[]): Rect {
  let x1 = hq.x, y1 = hq.y, x2 = hq.x + hq.w, y2 = hq.y + hq.h;
  for (const t of territories) { x1 = Math.min(x1, t.x); y1 = Math.min(y1, t.y); x2 = Math.max(x2, t.x + t.w); y2 = Math.max(y2, t.y + t.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The centre of a territory, hq, building or unit — where "focus" pans to. */
export function centreOf(layout: MapLayout, target: { building?: string; unit?: string; structure?: string }): { x: number; y: number } | null {
  if (target.unit && layout.units[target.unit]) return layout.units[target.unit];
  if (target.building && layout.buildings[target.building]) return layout.buildings[target.building];
  if (target.structure && layout.structures[target.structure]) return layout.structures[target.structure];
  return null;
}

export interface RoadGeometry {
  /** SVG path of the curve from the edge of one building to the edge of the other. */
  d: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  ctrl: { x: number; y: number };
  /** The point on the curve at t (0 = start, 1 = end): where a promo dot is. */
  at(t: number): { x: number; y: number };
  length: number;
}

/**
 * A road between two buildings: a quadratic curve that bends to the left of its direction (so the road back bends the
 * other way and two roads between the same pair do not overlap). Pure; the ends stop at the buildings' edges.
 */
export function roadGeometry(a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.16): RoadGeometry {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const start = { x: a.x + ux * (BUILDING_R + 4), y: a.y + uy * (BUILDING_R + 4) };
  const end = { x: b.x - ux * (BUILDING_R + 12), y: b.y - uy * (BUILDING_R + 12) };
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const ctrl = { x: mid.x - uy * len * bend, y: mid.y + ux * len * bend };
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    d: `M ${r(start.x)} ${r(start.y)} Q ${r(ctrl.x)} ${r(ctrl.y)} ${r(end.x)} ${r(end.y)}`,
    start, end, ctrl, length: len,
    at: (t) => ({
      x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * ctrl.x + t * t * end.x,
      y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * ctrl.y + t * t * end.y,
    }),
  };
}

/** Points of a flat-top hexagon of radius r around the origin (a building's plate). */
export function hexPoints(r: number): string {
  return [0, 60, 120, 180, 240, 300].map((deg) => `${Math.round(r * Math.cos((deg * Math.PI) / 180) * 100) / 100},${Math.round(r * Math.sin((deg * Math.PI) / 180) * 100) / 100}`).join(' ');
}
