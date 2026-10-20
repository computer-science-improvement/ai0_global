import type { MapAgentKind } from '../api/map';

// Spec 056 FR-005: the pixel avatar of an agent. An 8×8 sprite mirrored left to right, built from a hash of the handle
// (the same handle always gets the same face), a colour from a fixed palette of theme variables, and an accessory that
// says what the agent does (a crown for the manager, a quill for a writer, glasses for a reviewer...). No images, no
// external assets: the SVG is drawn from this data. Pure, so it is tested without a browser.

export const GRID = 8;
/** The sprite lives in a (GRID + 2) square so an accessory can stick out one cell on every side. */
export const SPRITE_VIEWBOX = `-1 -1 ${GRID + 2} ${GRID + 2}`;

/** Theme variables only (CSS colours), in a fixed order: the hash picks the index. */
export const AVATAR_PALETTE: readonly string[] = [
  'var(--color-accent)', 'var(--color-tg-link)', 'var(--color-chart-5)', 'var(--color-chart-6)',
  'var(--color-chart-7)', 'var(--color-chart-8)', 'var(--color-warning)',
];

/** 32-bit FNV-1a: tiny, stable, and spreads similar handles ("recipes_ua", "recipes_ub") well enough. */
export function hashHandle(handle: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < handle.length; i++) {
    h ^= handle.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a seeded generator, so a handle's random cells never change. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Sprite {
  /** cells[y][x], GRID × GRID, symmetric: cells[y][x] === cells[y][GRID - 1 - x]. */
  cells: boolean[][];
  colorIndex: number;
  color: string;
}

/** Eyes sit on row 3 at these columns; the sprite always has those cells filled and draws them dark, so the face is readable. */
export const EYES: ReadonlyArray<readonly [number, number]> = [[2, 3], [5, 3]];

const normalise = (handle: string) => handle.trim().replace(/^@/, '').toLowerCase();

export function spriteOf(handle: string): Sprite {
  const hash = hashHandle(normalise(handle));
  const rnd = seeded(hash);
  const cells: boolean[][] = Array.from({ length: GRID }, () => Array<boolean>(GRID).fill(false));
  const half = GRID / 2;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < half; x++) {
      // The middle columns are likelier (a body in the middle), the edges and the top and bottom rows are sparse.
      const edge = x === 0 ? 0.32 : x === 1 ? 0.52 : x === 2 ? 0.66 : 0.8;
      const rim = y === 0 || y === GRID - 1 ? 0.55 : 1;
      cells[y][x] = rnd() < edge * rim;
    }
  }
  // A body: the middle four rows of the middle columns are always filled, and the eyes' cells.
  for (let y = 2; y <= 5; y++) cells[y][3] = true;
  for (const [x, y] of EYES) cells[y][x] = true;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < half; x++) cells[y][GRID - 1 - x] = cells[y][x];
  const colorIndex = (hash >>> 8) % AVATAR_PALETTE.length;
  return { cells, colorIndex, color: AVATAR_PALETTE[colorIndex] };
}

export const filledCells = (s: Pick<Sprite, 'cells'>): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  s.cells.forEach((row, y) => row.forEach((on, x) => { if (on) out.push([x, y]); }));
  return out;
};

export type AccessoryTone = 'gold' | 'ink';
export interface AccessoryPixel { x: number; y: number; tone: AccessoryTone }

const px = (tone: AccessoryTone, pts: Array<[number, number]>): AccessoryPixel[] => pts.map(([x, y]) => ({ x, y, tone }));

/** What each kind carries. Coordinates are in sprite cells; -1 and GRID are the margin around the sprite. */
export const ACCESSORIES: Record<MapAgentKind, AccessoryPixel[]> = {
  // a crown
  manager: px('gold', [[1, -1], [3, -1], [4, -1], [6, -1], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]]),
  // a hard hat
  builder: px('gold', [[2, -1], [3, -1], [4, -1], [5, -1], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]]),
  // a headset
  orchestrator: px('ink', [[2, -1], [3, -1], [4, -1], [5, -1], [0, 2], [0, 3], [0, 4], [7, 2], [7, 3], [7, 4]]),
  // a scroll
  planner: px('ink', [[7, 4], [8, 4], [7, 5], [8, 5], [7, 6], [8, 6], [7, 7], [8, 7]]),
  // a light bulb
  ideator: px('gold', [[6, -1], [7, -1], [6, 0], [7, 0], [7, 1]]),
  // a magnifying glass
  idea_reviewer: px('ink', [[6, 5], [7, 5], [6, 6], [7, 6], [8, 7]]),
  // a quill
  executor: px('ink', [[8, 1], [7, 2], [8, 2], [6, 3], [7, 3], [5, 4], [6, 4], [4, 5], [5, 5], [4, 6]]),
  // glasses: a frame around each eye
  reviewer: px('ink', [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [1, 3], [3, 3], [4, 3], [6, 3], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4]]),
};

export const accessoryOf = (kind: MapAgentKind): AccessoryPixel[] => ACCESSORIES[kind] ?? [];
