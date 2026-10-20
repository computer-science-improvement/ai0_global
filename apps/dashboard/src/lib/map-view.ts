// Spec 056 FR-003: pan and zoom of the map as pure functions over a view transform.
// A world point (wx, wy) is drawn at screen (wx * k + x, wy * k + y).

export interface View { x: number; y: number; k: number }
export interface Size { w: number; h: number }
export interface Box { x: number; y: number; w: number; h: number }

export const MIN_K = 0.12;
export const MAX_K = 3;
/** "Fit" never magnifies a small network beyond this. */
export const FIT_MAX_K = 1.15;
export const ZOOM_STEP = 1.25;

export const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k));

export interface Inset { top: number; right: number; bottom: number; left: number }

/**
 * Centre the bounds in the viewport at the largest zoom that shows all of it. `inset` keeps clear of overlays
 * (the top bar, the zoom buttons): the fit happens inside the remaining rectangle.
 */
export function fitView(bounds: Box, vp: Size, margin = 32, inset: Inset = { top: 0, right: 0, bottom: 0, left: 0 }): View {
  const w = vp.w - inset.left - inset.right;
  const h = vp.h - inset.top - inset.bottom;
  if (w <= 0 || h <= 0 || bounds.w <= 0 || bounds.h <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampK(Math.min(FIT_MAX_K, (w - 2 * margin) / bounds.w, (h - 2 * margin) / bounds.h));
  return { k, x: inset.left + (w - bounds.w * k) / 2 - bounds.x * k, y: inset.top + (h - bounds.h * k) / 2 - bounds.y * k };
}

/** Zoom to `k` keeping the world point under screen (px, py) where it is. */
export function zoomAt(v: View, k: number, px: number, py: number): View {
  const nk = clampK(k);
  const wx = (px - v.x) / v.k;
  const wy = (py - v.y) / v.k;
  return { k: nk, x: px - wx * nk, y: py - wy * nk };
}

export const zoomBy = (v: View, factor: number, px: number, py: number): View => zoomAt(v, v.k * factor, px, py);

export const panBy = (v: View, dx: number, dy: number): View => ({ ...v, x: v.x + dx, y: v.y + dy });

/** Keep at least `keep` pixels of the world on screen, so the map cannot be dragged out of sight. */
export function clampPan(v: View, bounds: Box, vp: Size, keep = 120): View {
  const minX = keep - (bounds.x + bounds.w) * v.k;
  const maxX = vp.w - keep - bounds.x * v.k;
  const minY = keep - (bounds.y + bounds.h) * v.k;
  const maxY = vp.h - keep - bounds.y * v.k;
  return { ...v, x: Math.min(maxX, Math.max(minX, v.x)), y: Math.min(maxY, Math.max(minY, v.y)) };
}

export const toWorld = (v: View, sx: number, sy: number): { x: number; y: number } => ({ x: (sx - v.x) / v.k, y: (sy - v.y) / v.k });

/** Pan (and zoom in to at least `minK`) so the world point is at the centre of the viewport. */
export function centreOn(v: View, wx: number, wy: number, vp: Size, minK = 0.9): View {
  const k = clampK(Math.max(v.k, minK));
  return { k, x: vp.w / 2 - wx * k, y: vp.h / 2 - wy * k };
}

/** Distance and midpoint of two touch points (for pinch zoom). */
export function pinch(a: { x: number; y: number }, b: { x: number; y: number }): { dist: number; mx: number; my: number } {
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

/** Zoom percent for the label ("85%"). */
export const zoomPercent = (v: View): string => `${Math.round(v.k * 100)}%`;

/** Labels (handles, titles) are drawn only when the map is zoomed in enough to read them. */
export const showUnitLabels = (k: number): boolean => k >= 0.8;
export const showBuildingMeta = (k: number): boolean => k >= 0.45;
