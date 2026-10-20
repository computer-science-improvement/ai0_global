import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ZOOM_STEP, centreOn, clampPan, fitView, panBy, pinch, zoomAt, zoomBy, type Inset, type Size, type View } from '../../lib/map-view';
import type { Rect } from '../../lib/map-layout';

/**
 * Spec 056 FR-003: the map's viewport — pan by drag, zoom by wheel / pinch / buttons / keys, fit, and "focus on a point".
 * The pure maths is in lib/map-view.ts. Until the viewer moves the map themselves, it stays fitted (it re-fits when the
 * window or the network changes size); after that it keeps the viewer's view.
 */

const DRAG_THRESHOLD = 5;
const ANIMATE_MS = 480;

export function useMapViewport(bounds: Rect | null, inset: Inset) {
  // A callback ref: the stage mounts after the data has loaded, so effects must wait for the element, not for the first render.
  const elRef = useRef<HTMLDivElement | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => { elRef.current = node; setEl(node); }, []);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [view, setViewState] = useState<View>({ x: 0, y: 0, k: 1 });
  const [animated, setAnimated] = useState(false);
  const [dragging, setDragging] = useState(false);
  const touched = useRef(false);
  const viewRef = useRef(view);
  const sizeRef = useRef(size);
  const boundsRef = useRef(bounds);
  const insetRef = useRef(inset);
  const wasDrag = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  sizeRef.current = size;
  boundsRef.current = bounds;
  insetRef.current = inset;

  const setView = useCallback((v: View, animate = false) => {
    const b = boundsRef.current;
    const next = b ? clampPan(v, b, sizeRef.current) : v;
    viewRef.current = next;
    setViewState(next);
    if (timer.current) clearTimeout(timer.current);
    setAnimated(animate);
    if (animate) timer.current = setTimeout(() => setAnimated(false), ANIMATE_MS);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The container's size.
  useEffect(() => {
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  // Stay fitted until the viewer moves the map.
  const boundsKey = bounds ? `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.w)},${Math.round(bounds.h)}` : '';
  const compact = size.w < 640;
  useEffect(() => {
    if (!bounds || size.w <= 0 || touched.current) return;
    setView(fitView(bounds, size, compact ? 16 : 32, insetRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, size.w, size.h, compact]);

  const fit = useCallback(() => {
    const b = boundsRef.current;
    if (!b) return;
    touched.current = false;
    setView(fitView(b, sizeRef.current, sizeRef.current.w < 640 ? 16 : 32, insetRef.current), true);
  }, [setView]);

  const zoomIn = useCallback(() => { touched.current = true; setView(zoomBy(viewRef.current, ZOOM_STEP, sizeRef.current.w / 2, sizeRef.current.h / 2), true); }, [setView]);
  const zoomOut = useCallback(() => { touched.current = true; setView(zoomBy(viewRef.current, 1 / ZOOM_STEP, sizeRef.current.w / 2, sizeRef.current.h / 2), true); }, [setView]);

  /** Pan (and zoom in a little, if far out) so a world point is in the middle of what is visible. */
  const focusOn = useCallback((x: number, y: number, minK = 0.9) => {
    touched.current = true;
    const i = insetRef.current;
    const s = sizeRef.current;
    const inner = { w: s.w - i.left - i.right, h: s.h - i.top - i.bottom };
    const v = centreOn(viewRef.current, x, y, inner, minK);
    setView({ ...v, x: v.x + i.left, y: v.y + i.top }, true);
  }, [setView]);

  // ── pointers: drag to pan, two fingers to pinch ──
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view0: View; x0: number; y0: number; dist0: number; mx0: number; my0: number } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = elRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    wasDrag.current = false;
    pointers.current.set(e.pointerId, local(e));
    const pts = [...pointers.current.values()];
    const m = pts.length === 2 ? pinch(pts[0], pts[1]) : null;
    gesture.current = { view0: viewRef.current, x0: pts[0].x, y0: pts[0].y, dist0: m?.dist ?? 0, mx0: m?.mx ?? 0, my0: m?.my ?? 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length >= 2) {
      const m = pinch(pts[0], pts[1]);
      if (g.dist0 <= 0) { gesture.current = { ...g, view0: viewRef.current, dist0: m.dist, mx0: m.mx, my0: m.my }; return; }
      wasDrag.current = true;
      touched.current = true;
      setDragging(true);
      const z = zoomAt(g.view0, g.view0.k * (m.dist / g.dist0), g.mx0, g.my0);
      setView(panBy(z, m.mx - g.mx0, m.my - g.my0));
      return;
    }
    const dx = pts[0].x - g.x0;
    const dy = pts[0].y - g.y0;
    if (!wasDrag.current) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      wasDrag.current = true;
      setDragging(true);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    }
    touched.current = true;
    setView(panBy(g.view0, dx, dy));
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) { gesture.current = null; setDragging(false); }
    else {
      // one finger left after a pinch: continue the pan from where it is
      const p = [...pointers.current.values()][0];
      gesture.current = { view0: viewRef.current, x0: p.x, y0: p.y, dist0: 0, mx0: 0, my0: 0 };
    }
  };

  // The wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018));
      setView(zoomBy(viewRef.current, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el, setView]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // a focused building or unit handles its own keys
    const step = 70;
    if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-' || e.key === '_') zoomOut();
    else if (e.key === '0') fit();
    else if (e.key === 'ArrowLeft') { touched.current = true; setView(panBy(viewRef.current, step, 0)); }
    else if (e.key === 'ArrowRight') { touched.current = true; setView(panBy(viewRef.current, -step, 0)); }
    else if (e.key === 'ArrowUp') { touched.current = true; setView(panBy(viewRef.current, 0, step)); }
    else if (e.key === 'ArrowDown') { touched.current = true; setView(panBy(viewRef.current, 0, -step)); }
    else return;
    e.preventDefault();
  };

  return {
    ref, size, view, animated, dragging, fit, zoomIn, zoomOut, focusOn,
    /** True right after a drag: the click that ends it must not clear the selection. */
    wasDrag: () => wasDrag.current,
    handlers: { onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer, onKeyDown },
  };
}

export type MapViewport = ReturnType<typeof useMapViewport>;
