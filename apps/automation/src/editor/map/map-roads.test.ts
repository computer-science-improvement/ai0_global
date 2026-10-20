/** Spec 058: the roads of the map are the current links (copy links of networks, promo links), with past roads on request. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoads, type RoadInput } from './map-roads';

const D = (s: string) => new Date(`2026-10-${s}T10:00:00Z`);
const TG = 'telegram:@a', IG = 'instagram:ig', FB = 'facebook:fb', TH = 'threads:th', LONE = 'telegram:@lone';

function input(over: Partial<RoadInput> = {}): RoadInput {
  return {
    resources: [{ ref: TG, groupId: 'n1' }, { ref: IG, groupId: 'n1' }, { ref: FB, groupId: 'n1' }, { ref: TH, groupId: null }, { ref: LONE, groupId: null }],
    networks: [{ id: 'n1', anchorRef: TG, mode: 'independent' }],
    traffic: { promo: [], reposts: [], derived: [] }, links: [], joins: new Map(), ...over,
  };
}
const brief = (r: ReturnType<typeof buildRoads>) => r.map((x) => [x.from, x.to, x.kind, x.relation, x.past, x.count30d]);

test('a network has a copy road from its anchor to every other member, with no traffic yet', () => {
  const roads = buildRoads(input());
  assert.deepEqual(brief(roads), [[TG, FB, 'adapt', 'network', false, 0], [TG, IG, 'adapt', 'network', false, 0]]);
  assert.ok(roads.every((r) => r.lastAt === null && r.linkedAt === null && !r.blocked));
});

test('a legacy network draws duplicate roads; the published copies of the last 30 days are counted on the member', () => {
  const roads = buildRoads(input({
    networks: [{ id: 'n1', anchorRef: TG, mode: 'legacy_duplicate' }],
    traffic: { promo: [], reposts: [], derived: [{ from: TG, to: IG, kind: 'duplicate', count: 4, lastAt: D('18') }, { from: TG, to: IG, kind: 'adapt', count: 1, lastAt: D('19') }] },
  }));
  const ig = roads.find((r) => r.to === IG)!;
  assert.deepEqual([ig.kind, ig.count30d, ig.lastAt], ['duplicate', 5, D('19').toISOString()]);
  assert.equal(roads.find((r) => r.to === FB)!.count30d, 0);
});

test('a network without an anchor (no Telegram channel) draws no copy roads', () => {
  assert.deepEqual(buildRoads(input({ networks: [{ id: 'n1', anchorRef: null, mode: 'independent' }] })), []);
});

test('a resource that left the network keeps only a past copy road, hidden by default', () => {
  const roads = buildRoads(input({
    resources: [{ ref: TG, groupId: 'n1' }, { ref: IG, groupId: null }, { ref: FB, groupId: 'n1' }],
    traffic: { promo: [], reposts: [], derived: [{ from: TG, to: IG, kind: 'adapt', count: 3, lastAt: D('15') }, { from: TG, to: FB, kind: 'adapt', count: 2, lastAt: D('16') }] },
  }));
  assert.deepEqual(brief(roads), [[TG, FB, 'adapt', 'network', false, 2], [TG, IG, 'adapt', 'network', true, 3]]);
});

test('a linked pair is one promo road even with no traffic; the side that promoted more is the source', () => {
  const links = [{ a: IG, b: TG, linkedAt: D('01'), blocked: false }];
  assert.deepEqual(brief(buildRoads(input({ links })).filter((r) => r.relation === 'promo')), [[IG, TG, 'promo', 'promo', false, 0]],
    'no traffic: the smaller ref is the source');
  const roads = buildRoads(input({
    links, traffic: { promo: [{ from: IG, to: TG, count: 1, lastAt: D('10') }, { from: TG, to: IG, count: 3, lastAt: D('12') }], reposts: [], derived: [] },
  })).filter((r) => r.relation === 'promo');
  assert.deepEqual(brief(roads), [[TG, IG, 'promo', 'promo', false, 4]], 'both directions are one road');
  assert.equal(roads[0].lastAt, D('12').toISOString());
  assert.equal(roads[0].linkedAt, D('01').toISOString());
});

test('a pair whose traffic is all reposts is a repost road; joins of both directions add up', () => {
  const r = buildRoads(input({
    resources: [{ ref: TG, groupId: null }, { ref: LONE, groupId: null }], networks: [],
    links: [{ a: LONE, b: TG, linkedAt: D('01'), blocked: false }],
    traffic: { promo: [{ from: TG, to: LONE, count: 2, lastAt: D('10') }], reposts: [{ from: TG, to: LONE, count: 2, lastAt: D('10') }], derived: [] },
    joins: new Map([[`${TG}>${LONE}`, 5], [`${LONE}>${TG}`, 2]]),
  }));
  assert.deepEqual([r[0].kind, r[0].count30d, r[0].joins30d], ['repost', 2, 7]);
  const mixed = buildRoads(input({
    resources: [{ ref: TG, groupId: null }, { ref: LONE, groupId: null }], networks: [],
    links: [{ a: LONE, b: TG, linkedAt: D('01'), blocked: false }],
    traffic: { promo: [{ from: TG, to: LONE, count: 3, lastAt: D('10') }], reposts: [{ from: TG, to: LONE, count: 1, lastAt: D('10') }], derived: [] },
  }));
  assert.equal(mixed[0].kind, 'promo');
  assert.equal(mixed[0].joins30d, null);
});

test('an unlinked pair with traffic is a past road; one the owner stopped says so; one without traffic is nothing', () => {
  const traffic = { promo: [{ from: TG, to: TH, count: 2, lastAt: D('10') }, { from: LONE, to: IG, count: 1, lastAt: D('11') }], reposts: [], derived: [] };
  const roads = buildRoads(input({
    traffic, links: [{ a: TG, b: TH, linkedAt: null, blocked: true }, { a: FB, b: LONE, linkedAt: null, blocked: true }],
  })).filter((r) => r.relation === 'promo');
  const stopped = roads.find((r) => r.to === TH)!;
  assert.deepEqual([stopped.past, stopped.blocked, stopped.linkedAt, stopped.count30d], [true, true, null, 2]);
  const unmarked = roads.find((r) => r.from === LONE)!;
  assert.deepEqual([unmarked.past, unmarked.blocked], [true, false], 'traffic with no link record is history, not stopped');
  assert.equal(roads.length, 2, 'a stopped pair with no traffic is not a road');
  assert.ok(roads.every((r) => r.past), 'past roads come last');
});

test('a pair that is both linked and blocked is not linked', () => {
  const roads = buildRoads(input({ links: [{ a: TG, b: TH, linkedAt: D('01'), blocked: true }] })).filter((r) => r.relation === 'promo');
  assert.deepEqual(roads, []);
});

test('roads between resources that are not connected are left out; current roads sort before past ones', () => {
  const roads = buildRoads(input({
    links: [{ a: TG, b: 'instagram:gone', linkedAt: D('01'), blocked: false }, { a: TG, b: TH, linkedAt: D('01'), blocked: false }],
    traffic: { promo: [{ from: TG, to: LONE, count: 9, lastAt: D('10') }, { from: TG, to: 'instagram:gone', count: 5, lastAt: D('10') }], reposts: [], derived: [] },
  }));
  assert.ok(!roads.some((r) => r.to === 'instagram:gone' || r.from === 'instagram:gone'));
  assert.deepEqual(roads.map((r) => r.past), [false, false, false, true]);
  assert.deepEqual(brief(roads).at(-1), [TG, LONE, 'promo', 'promo', true, 9]);
});
