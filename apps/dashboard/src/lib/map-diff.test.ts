import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapEvent, MapSnapshot, UnitState } from '../api/map';
import { demoSnapshot } from './map-demo';
import {
  EMPTY_DIFF, FAST_POLL_MS, FX_MAX, FX_MAX_AGE_MS, SLOW_POLL_MS, diffSnapshots, fxForBuilding, fxForRoad, fxForUnit, pollInterval,
} from './map-diff';

const NOW = new Date('2026-10-20T12:00:00Z');
const clone = (s: MapSnapshot): MapSnapshot => JSON.parse(JSON.stringify(s));
const later = (s: MapSnapshot, sec = 5): MapSnapshot => ({ ...s, generatedAt: new Date(new Date(s.generatedAt).getTime() + sec * 1000).toISOString() });
const setState = (s: MapSnapshot, id: string, state: UnitState) => { const u = s.units.find((x) => x.id === id)!; u.state = state; return u; };
const event = (over: Partial<MapEvent> & Pick<MapEvent, 'id' | 'kind'>): MapEvent => ({ at: NOW.toISOString(), agent: null, ref: null, text: 't', ...over });

// An orchestrator that is idle in the base snapshot.
const idleOrchestrator = (s: MapSnapshot) => s.units.find((u) => u.kind === 'orchestrator' && u.state === 'idle' && u.homeRef)!;

test('pollInterval: 5 s while any unit works, 30 s otherwise, nothing while the tab is hidden', () => {
  const base = demoSnapshot(0, NOW);
  const calm = clone(base);
  for (const u of calm.units) u.state = 'idle';
  assert.equal(pollInterval(calm), SLOW_POLL_MS);
  assert.equal(pollInterval(undefined), SLOW_POLL_MS);
  for (const w of ['planning', 'writing', 'reviewing', 'publishing'] as const) {
    const busy = clone(calm);
    busy.units[3].state = w;
    assert.equal(pollInterval(busy), FAST_POLL_MS, w);
  }
  for (const quiet of ['waiting', 'error', 'paused', 'off'] as const) {
    const s = clone(calm);
    s.units[3].state = quiet;
    assert.equal(pollInterval(s), SLOW_POLL_MS, quiet);
  }
  assert.equal(pollInterval(base, true), false);
  assert.equal(pollInterval(calm, true), false);
});

test('nothing animates on the first load, or when the snapshot did not change', () => {
  const s = demoSnapshot(3, NOW);
  assert.equal(diffSnapshots(null, s), EMPTY_DIFF);
  assert.equal(diffSnapshots(undefined, s), EMPTY_DIFF);
  assert.equal(diffSnapshots(s, s), EMPTY_DIFF);
  const same = diffSnapshots(s, later(clone(s)));
  assert.deepEqual(same.fx, []);
  assert.deepEqual(same.freshIds, []);
  assert.equal(same.alertBump, false);
});

test('a state change pulses the ring; writing adds a spark; publishing adds a plane to the unit\'s building; an error shakes it', () => {
  const prev = demoSnapshot(0, NOW);
  const u = idleOrchestrator(prev);

  for (const [to, extra] of [['writing', 'spark'], ['publishing', 'plane'], ['error', 'shake'], ['reviewing', null], ['planning', null]] as const) {
    const next = later(clone(prev));
    setState(next, u.id, to);
    const fx = fxForUnit(diffSnapshots(prev, next).fx, u.id);
    assert.deepEqual(fx.map((f) => f.kind).sort(), ['pulse', ...(extra ? [extra] : [])].sort(), to);
    const pulse = fx.find((f) => f.kind === 'pulse');
    assert.ok(pulse && pulse.kind === 'pulse' && pulse.to === to);
    const plane = fx.find((f) => f.kind === 'plane');
    if (plane && plane.kind === 'plane') assert.equal(plane.ref, u.homeRef);
  }
});

test('a unit that appears is not an animation; effects have unique ids', () => {
  const prev = demoSnapshot(0, NOW);
  const next = later(clone(prev));
  const u = clone(prev).units[2];
  next.units.push({ ...u, id: 'u-new', handle: 'brand_new', state: 'writing' });
  assert.deepEqual(diffSnapshots(prev, next).fx, []);

  const busy = later(clone(prev));
  for (const x of busy.units) x.state = x.state === 'idle' ? 'writing' : 'idle';
  const ids = diffSnapshots(prev, busy).fx.map((f) => f.id);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
});

test('a new published event flares its building once, counting posts; an old or known event does not', () => {
  const prev = demoSnapshot(0, NOW);
  const ref = 'telegram:@space_ua';
  const next = later(clone(prev));
  next.events = [
    event({ id: 'slot:a:published', kind: 'post_published', ref, agent: 'space_ua' }),
    event({ id: 'slot:b:published', kind: 'post_published', ref, agent: 'space_ua' }),
    event({ id: 'slot:old:published', kind: 'post_published', ref: 'telegram:@movies_ua', at: new Date(NOW.getTime() - FX_MAX_AGE_MS - 60_000).toISOString() }),
    ...prev.events,
  ];
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.freshIds, ['slot:a:published', 'slot:b:published', 'slot:old:published']);
  const flares = d.fx.filter((f) => f.kind === 'flare');
  assert.equal(flares.length, 1);
  assert.deepEqual(fxForBuilding(d.fx, ref).map((f) => (f.kind === 'flare' ? f.count : -1)), [2]);
  assert.deepEqual(fxForBuilding(d.fx, 'telegram:@movies_ua'), []);

  // The same events again: nothing is new.
  const again = diffSnapshots(next, later(clone(next)));
  assert.deepEqual(again.fx, []);
  assert.deepEqual(again.freshIds, []);
});

test('a new promo event sends a dot along its road (once per road)', () => {
  const prev = demoSnapshot(0, NOW);
  const next = later(clone(prev));
  next.events = [
    event({ id: 'promo:1', kind: 'promo', ref: 'telegram:@ai0_global', toRef: 'instagram:ig-tech', agent: 'ai0_global' }),
    event({ id: 'promo:2', kind: 'promo', ref: 'telegram:@ai0_global', toRef: 'instagram:ig-tech', agent: 'ai0_global' }),
    event({ id: 'promo:3', kind: 'promo', ref: 'telegram:@ai0_global' }),
    ...prev.events,
  ];
  const d = diffSnapshots(prev, next);
  assert.deepEqual(fxForRoad(d.fx, 'telegram:@ai0_global>instagram:ig-tech>promo').length, 1);
  assert.equal(d.fx.filter((f) => f.kind === 'promo').length, 1);
});

test('a new failure shakes the unit once, even when its state also changed to error', () => {
  const prev = demoSnapshot(0, NOW);
  const u = idleOrchestrator(prev);
  const next = later(clone(prev));
  setState(next, u.id, 'error');
  next.events = [
    event({ id: 'run:x:fail', kind: 'run_failed', agent: u.handle, ref: u.homeRef }),
    event({ id: 'slot:y:fail', kind: 'post_failed', agent: u.handle, ref: u.homeRef }),
    ...prev.events,
  ];
  const d = diffSnapshots(prev, next);
  assert.equal(fxForUnit(d.fx, u.id).filter((f) => f.kind === 'shake').length, 1);
  // A failure of an agent that is not on the map is only a feed line.
  const ghost = later(clone(prev));
  ghost.events = [event({ id: 'run:z:fail', kind: 'run_failed', agent: 'nobody' }), ...prev.events];
  assert.deepEqual(diffSnapshots(prev, ghost).fx, []);
  assert.deepEqual(diffSnapshots(prev, ghost).freshIds, ['run:z:fail']);
});

test('a new alert bursts its beacon and bumps the counter; a shrinking or equal alert does not', () => {
  const prev = demoSnapshot(0, NOW);
  const grown = later(clone(prev));
  grown.alerts[0].count += 1;
  const d = diffSnapshots(prev, grown);
  assert.equal(d.alertBump, true);
  assert.deepEqual(fxForBuilding(d.fx, grown.alerts[0].ref!).map((f) => f.kind), ['alert']);

  const added = later(clone(prev));
  added.alerts.push({ kind: 'budget', count: 1, ref: null, agent: null, title: 'The daily cap is reached', path: '/app/spend' });
  const d2 = diffSnapshots(prev, added);
  assert.equal(d2.alertBump, true);
  assert.deepEqual(d2.fx.map((f) => f.kind), ['alert']);

  const shrunk = later(clone(prev));
  shrunk.alerts = shrunk.alerts.slice(1);
  const d3 = diffSnapshots(prev, shrunk);
  assert.equal(d3.alertBump, false);
  assert.deepEqual(d3.fx, []);
});

test('a burst is capped', () => {
  const prev = demoSnapshot(0, NOW);
  const next = later(clone(prev));
  for (const u of next.units) u.state = u.state === 'idle' ? 'publishing' : 'idle';
  const d = diffSnapshots(prev, next);
  assert.ok(prev.units.length > FX_MAX);
  assert.equal(d.fx.length, FX_MAX);
});

test('after a long gap (a background tab) nothing is replayed, but the feed still marks the new lines and alerts still count', () => {
  const prev = demoSnapshot(0, NOW);
  const next = later(clone(prev), FX_MAX_AGE_MS / 1000 + 30);
  setState(next, idleOrchestrator(prev).id, 'writing');
  next.events = [event({ id: 'slot:late:published', kind: 'post_published', ref: 'telegram:@space_ua', at: next.generatedAt }), ...prev.events];
  next.alerts[0].count += 1;
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.fx.map((f) => f.kind), ['alert']);
  assert.deepEqual(d.freshIds, ['slot:late:published']);
  assert.equal(d.alertBump, true);
});
