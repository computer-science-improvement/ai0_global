import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARC_R, BUILDING_R, FRONT_DY, STRUCT_R, UNIT_R, hexPoints, infraSectionId, layoutMap, platformSectionId, roadGeometry, type MapLayout } from './map-layout';
import { demoSnapshot } from './map-demo';

const demo = demoSnapshot(0);
const input = (s = demo) => ({ networks: s.networks, resources: s.resources, units: s.units, infra: s.infra });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test('same input in any order gives the same positions', () => {
  const a = layoutMap(input());
  const shuffled = {
    networks: [...demo.networks].reverse(),
    resources: [...demo.resources].sort((x, y) => (x.ref < y.ref ? 1 : -1)),
    units: [...demo.units].reverse(),
    infra: [...(demo.infra ?? [])].reverse(),
  };
  assert.deepEqual(layoutMap(shuffled), a);
  assert.deepEqual(layoutMap(input()), a, 'and run twice');
});

test('every resource gets a building and every unit a place', () => {
  const l = layoutMap(input());
  for (const r of demo.resources) assert.ok(l.buildings[r.ref], r.ref);
  for (const u of demo.units) assert.ok(l.units[u.id], u.handle);
  assert.equal(Object.keys(l.buildings).length, demo.resources.length);
});

test('sections: the largest network first, then one per platform outside a network, then the connections on a row of their own; none overlapping', () => {
  const l = layoutMap(input());
  assert.deepEqual(l.territories.map((t) => t.id), [
    'g-tech', 'g-food', 'g-space', platformSectionId('telegram'), platformSectionId('instagram'), platformSectionId('facebook'),
    infraSectionId('bot'), infraSectionId('mtproto'), infraSectionId('telegraph'),
  ]);
  assert.deepEqual(l.territories.slice(3).map((t) => [t.name, t.kind]), [
    ['Telegram channels', 'platform'], ['Instagram', 'platform'], ['Facebook pages', 'platform'], ['Telegram bots', 'infra'], ['MTProto sessions', 'infra'], ['Telegraph accounts', 'infra'],
  ]);
  const lastResourceBottom = Math.max(...l.territories.filter((t) => t.kind !== 'infra').map((t) => t.y + t.h));
  for (const t of l.territories.filter((x) => x.kind === 'infra')) assert.ok(t.y >= lastResourceBottom, `${t.id} below every channel section`);
  for (let i = 0; i < l.territories.length; i++) {
    for (let j = i + 1; j < l.territories.length; j++) {
      const a = l.territories[i], b = l.territories[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('every connection gets a structure inside its section, none overlapping, and never a building', () => {
  const l = layoutMap(input());
  for (const i of demo.infra ?? []) {
    const p = l.structures[i.id];
    assert.ok(p, i.id);
    assert.equal(l.buildings[i.id], undefined);
    const t = l.territories.find((x) => x.id === p.territory)!;
    assert.equal(t.id, infraSectionId(i.kind));
    assert.ok(p.x - STRUCT_R >= t.x && p.x + STRUCT_R <= t.x + t.w && p.y - STRUCT_R >= t.y && p.y + STRUCT_R <= t.y + t.h, `${i.id} inside`);
  }
  const ps = Object.values(l.structures);
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(dist(ps[i], ps[j]) > 2 * STRUCT_R + 40);
  assert.deepEqual(layoutMap({ ...input(), infra: undefined }).structures, {}, 'an older server without infra');
});

test('a building sits inside its territory; the anchor is in the middle of its network', () => {
  const l = layoutMap(input());
  for (const t of l.territories.filter((x) => x.kind !== 'infra')) {
    for (const ref of t.refs) {
      const b = l.buildings[ref];
      assert.ok(b.x - BUILDING_R >= t.x && b.x + BUILDING_R <= t.x + t.w && b.y - BUILDING_R >= t.y && b.y + BUILDING_R <= t.y + t.h, `${ref} inside ${t.id}`);
    }
  }
  const tech = l.territories.find((t) => t.id === 'g-tech')!;
  const anchor = l.buildings['telegram:@ai0_global'];
  assert.equal(anchor.anchor, true);
  assert.ok(Math.abs(anchor.x - (tech.x + tech.w / 2)) < 0.01, 'horizontally centred');
  for (const ref of tech.refs.filter((r) => r !== 'telegram:@ai0_global')) {
    assert.ok(dist(l.buildings[ref], anchor) > 190, `${ref} on the ring`);
  }
});

test('no two buildings overlap and their units keep clear of other buildings', () => {
  const l = layoutMap(input());
  const bs = Object.entries(l.buildings);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    assert.ok(dist(bs[i][1], bs[j][1]) > 2 * BUILDING_R + 2 * UNIT_R, `${bs[i][0]} / ${bs[j][0]}`);
  }
  for (const u of demo.units.filter((x) => x.homeRef)) {
    for (const [ref, b] of bs) {
      if (ref === u.homeRef) continue;
      assert.ok(dist(l.units[u.id], b) > BUILDING_R + UNIT_R, `${u.handle} stands on ${ref}`);
    }
  }
});

test('units: the orchestrator in front of its building, role children on the arc behind it', () => {
  const l = layoutMap(input());
  const home = l.buildings['telegram:@recipes_ua'];
  const orch = demo.units.find((u) => u.kind === 'orchestrator' && u.homeRef === 'telegram:@recipes_ua')!;
  assert.deepEqual(l.units[orch.id], { x: home.x, y: home.y + FRONT_DY, zone: 'front' });
  const kids = demo.units.filter((u) => u.parentId === orch.id);
  assert.equal(kids.length, 4);
  for (const k of kids) {
    const p = l.units[k.id];
    assert.equal(p.zone, 'back');
    assert.ok(p.y < home.y, 'behind (above) the building');
    assert.ok(Math.abs(dist(p, home) - ARC_R) < 0.01);
  }
  assert.equal(new Set(kids.map((k) => `${l.units[k.id].x},${l.units[k.id].y}`)).size, 4, 'distinct places');
});

test('headquarters at the top centre holds the system agents', () => {
  const l = layoutMap(input());
  const manager = l.units['u-manager'];
  assert.equal(manager.zone, 'hq');
  assert.equal(l.units['u-ai0'].zone, 'hq');
  assert.ok(l.hq.y <= l.territories.reduce((m, t) => Math.min(m, t.y), Infinity), 'above every territory');
  const centre = l.bounds.x + l.bounds.w / 2;
  assert.ok(Math.abs(l.hq.x + l.hq.w / 2 - centre) < 0.01, 'horizontally centred on the map');
  assert.ok(manager.x >= l.hq.x && manager.x <= l.hq.x + l.hq.w && manager.y >= l.hq.y && manager.y <= l.hq.y + l.hq.h);
});

test('a unit whose building is missing stands in the headquarters', () => {
  const l = layoutMap({ networks: [], resources: [], units: [{ id: 'x', handle: 'lost', kind: 'orchestrator', parentId: null, homeRef: 'telegram:@gone' }] });
  assert.equal(l.units.x.zone, 'hq');
});

test('an empty network still has bounds (the headquarters)', () => {
  const l = layoutMap({ networks: [], resources: [], units: [] });
  assert.deepEqual(l.territories, []);
  assert.ok(l.bounds.w > 0 && l.bounds.h > 0);
});

test('a resource whose network is unknown goes to its platform section; a network with one resource is a small territory', () => {
  const l = layoutMap({
    networks: [{ id: 'n1', name: 'Solo', anchorRef: 'telegram:@a' }],
    resources: [
      { ref: 'telegram:@a', groupId: 'n1', platform: 'telegram' },
      { ref: 'telegram:@b', groupId: 'deleted', platform: 'telegram' },
      { ref: 'instagram:1', groupId: null, platform: 'instagram' },
    ],
    units: [],
  });
  assert.deepEqual(l.territories.map((t) => [t.id, t.refs.length]), [['n1', 1], [platformSectionId('telegram'), 1], [platformSectionId('instagram'), 1]]);
  const solo = l.territories[0];
  assert.ok(solo.w < 300);
});

test('the layout never produces NaN for odd sizes, and wraps many territories into rows', () => {
  const resources = [];
  const networks = [];
  for (let i = 0; i < 12; i++) {
    networks.push({ id: `n${i}`, name: `Net ${i}`, anchorRef: `telegram:@c${i}` });
    resources.push({ ref: `telegram:@c${i}`, groupId: `n${i}`, platform: 'telegram' as const });
    for (let j = 0; j < i % 4; j++) resources.push({ ref: `instagram:${i}-${j}`, groupId: `n${i}`, platform: 'instagram' as const });
  }
  const l: MapLayout = layoutMap({ networks, resources, units: [] });
  assert.equal(l.territories.length, 12);
  assert.ok(new Set(l.territories.map((t) => t.y)).size > 1, 'more than one row');
  assert.ok(l.bounds.w <= 1500 + 1, `bounded width ${l.bounds.w}`);
  for (const b of Object.values(l.buildings)) assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
});

test('a road runs between the edges of two buildings and bends to its left; the road back bends the other way', () => {
  const a = { x: 0, y: 0 }, b = { x: 400, y: 0 };
  const ab = roadGeometry(a, b);
  const ba = roadGeometry(b, a);
  assert.ok(ab.start.x > BUILDING_R && ab.end.x < 400 - BUILDING_R, 'stops at the buildings');
  assert.ok(ab.ctrl.y > 0 && ba.ctrl.y < 0 || ab.ctrl.y < 0 && ba.ctrl.y > 0, 'opposite sides');
  assert.deepEqual(ab.at(0), ab.start);
  assert.ok(Math.abs(ab.at(1).x - ab.end.x) < 1e-9);
  assert.ok(Math.abs(ab.at(0.5).x - 200) < 20);
  assert.match(ab.d, /^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/);
  assert.equal(roadGeometry(a, b).d, ab.d, 'deterministic');
  assert.ok(Number.isFinite(roadGeometry(a, a).ctrl.x), 'two buildings in one place do not give NaN');
});

test('hexPoints is a hexagon of six points on the radius', () => {
  const pts = hexPoints(30).split(' ').map((p) => p.split(',').map(Number));
  assert.equal(pts.length, 6);
  for (const [x, y] of pts) assert.ok(Math.abs(Math.hypot(x, y) - 30) < 0.05);
});
