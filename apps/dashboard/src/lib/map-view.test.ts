import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_K, MIN_K, centreOn, clampK, clampPan, fitView, panBy, pinch, toWorld, zoomAt, zoomBy, zoomPercent } from './map-view';

const vp = { w: 1000, h: 600 };

test('fit centres the bounds and shows all of them', () => {
  const b = { x: 100, y: 50, w: 2000, h: 1000 };
  const v = fitView(b, vp);
  assert.ok(v.k < 1 && v.k >= MIN_K);
  const tl = { x: b.x * v.k + v.x, y: b.y * v.k + v.y };
  const br = { x: (b.x + b.w) * v.k + v.x, y: (b.y + b.h) * v.k + v.y };
  assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= vp.w && br.y <= vp.h);
  assert.ok(Math.abs(tl.x - (vp.w - br.x)) < 0.01, 'centred horizontally');
  assert.ok(Math.abs(tl.y - (vp.h - br.y)) < 0.01, 'centred vertically');
});

test('fit keeps clear of the inset (the top bar)', () => {
  const b = { x: 0, y: 0, w: 2000, h: 1000 };
  const v = fitView(b, vp, 32, { top: 80, right: 0, bottom: 20, left: 0 });
  assert.ok(b.y * v.k + v.y >= 80, 'starts below the top bar');
  assert.ok((b.y + b.h) * v.k + v.y <= vp.h - 20);
});

test('fit does not magnify a small network, and survives a zero viewport', () => {
  assert.ok(fitView({ x: 0, y: 0, w: 100, h: 100 }, vp).k <= 1.15);
  assert.deepEqual(fitView({ x: 0, y: 0, w: 100, h: 100 }, { w: 0, h: 0 }), { x: 0, y: 0, k: 1 });
});

test('zoom keeps the point under the cursor fixed', () => {
  const v = { x: 40, y: -20, k: 0.5 };
  const before = toWorld(v, 300, 200);
  const z = zoomBy(v, 2, 300, 200);
  const after = toWorld(z, 300, 200);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(z.k, 1);
});

test('zoom is clamped', () => {
  assert.equal(clampK(100), MAX_K);
  assert.equal(clampK(0), MIN_K);
  assert.equal(zoomAt({ x: 0, y: 0, k: 1 }, 99, 0, 0).k, MAX_K);
});

test('pan moves the view; clampPan keeps part of the map on screen', () => {
  assert.deepEqual(panBy({ x: 1, y: 2, k: 1 }, 10, -5), { x: 11, y: -3, k: 1 });
  const b = { x: 0, y: 0, w: 1000, h: 800 };
  const far = clampPan({ x: 99999, y: -99999, k: 1 }, b, vp);
  assert.ok(far.x <= vp.w - 120 && far.y >= 120 - b.h);
  const ok = { x: 10, y: 10, k: 1 };
  assert.deepEqual(clampPan(ok, b, vp), ok, 'a sensible view is untouched');
});

test('centreOn puts a world point in the middle and zooms in to at least the minimum', () => {
  const v = centreOn({ x: 0, y: 0, k: 0.3 }, 500, 400, vp, 0.9);
  assert.equal(v.k, 0.9);
  assert.ok(Math.abs(500 * v.k + v.x - vp.w / 2) < 1e-9 && Math.abs(400 * v.k + v.y - vp.h / 2) < 1e-9);
  assert.equal(centreOn({ x: 0, y: 0, k: 2 }, 0, 0, vp).k, 2, 'never zooms out');
});

test('pinch reports distance and midpoint', () => {
  assert.deepEqual(pinch({ x: 0, y: 0 }, { x: 6, y: 8 }), { dist: 10, mx: 3, my: 4 });
  assert.equal(zoomPercent({ x: 0, y: 0, k: 0.854 }), '85%');
});
