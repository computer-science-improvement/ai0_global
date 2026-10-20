import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from './map-demo';
import {
  LINK_LIMIT, diffLine, isCurrentRoad, linkDiff, linkSections, networkMates, pastRoadCount, plannedPromos, promoPartners,
  stoppedPartners, visibleRoads,
} from './map-links';

const snap = demoSnapshot(0);
const refs = (rs: { ref: string }[]) => rs.map((r) => r.ref).sort();

test('the map draws the current links; past ones only when asked for', () => {
  const all = snap.roads;
  assert.ok(pastRoadCount(all) >= 3);
  assert.ok(visibleRoads(all, false).every(isCurrentRoad));
  assert.equal(visibleRoads(all, false).length, all.length - pastRoadCount(all));
  assert.equal(visibleRoads(all, true).length, all.length);
  // a server older than spec 058 sends no `past`: every road is current
  assert.ok(isCurrentRoad({ past: undefined }));
});

test('promo partners are the current promo links of a resource, either direction; copy links are not partners', () => {
  assert.deepEqual(refs(promoPartners(snap, 'telegram:@ai0_global')), ['instagram:ig-tech', 'telegram:@space_ua']);
  // a linked pair with no traffic yet is a partner
  assert.deepEqual(refs(promoPartners(snap, 'instagram:ig-solo')), ['telegram:@movies_ua']);
  // past roads are not
  assert.ok(!refs(promoPartners(snap, 'telegram:@gaming_ua')).includes('telegram:@movies_ua'));
  // the Food copy links are not promo partners
  assert.ok(!refs(promoPartners(snap, 'telegram:@recipes_ua')).includes('instagram:ig-food'));
});

test('stopped partners are the pairs the owner unlinked', () => {
  assert.deepEqual([...stoppedPartners(snap, 'telegram:@movies_ua')], ['telegram:@gaming_ua']);
  assert.deepEqual([...stoppedPartners(snap, 'telegram:@gaming_ua')], ['telegram:@movies_ua']);
  assert.equal(stoppedPartners(snap, 'telegram:@ai0_global').size, 0);
});

test('network mates are the other members; none outside a network', () => {
  const anchor = snap.resources.find((r) => r.ref === 'telegram:@ai0_global')!;
  assert.deepEqual(refs(networkMates(snap, anchor)), ['facebook:fb-tech', 'instagram:ig-tech', 'threads:th-tech', 'tiktok:tt-tech']);
  const solo = snap.resources.find((r) => r.ref === 'instagram:ig-solo')!;
  assert.deepEqual(networkMates(snap, solo), []);
});

test('the picker groups by network, then by platform for the free ones, and filters', () => {
  const sections = linkSections(snap, 'telegram:@ai0_global');
  const ids = sections.map((s) => s.id);
  assert.ok(ids.includes('network:g-food') && ids.includes('network:g-tech') && ids.includes('network:g-space'));
  assert.ok(ids.findIndex((i) => i === 'network:g-food') < ids.findIndex((i) => i.startsWith('platform:')));
  const all = sections.flatMap((s) => s.items.map((i) => i.res.ref));
  assert.ok(!all.includes('telegram:@ai0_global'), 'the resource itself is not offered');
  assert.equal(new Set(all).size, all.length, 'every resource is listed once');
  assert.equal(all.length, snap.resources.length - 1);
  const linked = sections.flatMap((s) => s.items).filter((i) => i.linked).map((i) => i.res.ref).sort();
  assert.deepEqual(linked, ['instagram:ig-tech', 'telegram:@space_ua']);

  const q = linkSections(snap, 'telegram:@ai0_global', ' food ').flatMap((s) => s.items.map((i) => i.res.ref)).sort();
  assert.ok(q.includes('instagram:ig-food') && q.includes('tiktok:tt-food'));
  assert.ok(!q.includes('telegram:@movies_ua'));
  assert.deepEqual(linkSections(snap, 'telegram:@ai0_global', 'zzzz-no-match'), []);

  const stopped = linkSections(snap, 'telegram:@movies_ua').flatMap((s) => s.items).find((i) => i.res.ref === 'telegram:@gaming_ua')!;
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.linked, false);
});

test('what Apply sends is the difference against the links the resource had', () => {
  const initial = new Set(['a', 'b', 'c']);
  assert.deepEqual(linkDiff(initial, new Set(['a', 'b', 'c'])), { add: [], remove: [] });
  assert.deepEqual(linkDiff(initial, new Set(['a', 'd', 'e'])), { add: ['d', 'e'], remove: ['b', 'c'] });
  assert.deepEqual(linkDiff(new Set(), new Set(['x'])), { add: ['x'], remove: [] });
  assert.equal(diffLine(0, 0), 'No changes');
  assert.equal(diffLine(3, 0), '3 to link');
  assert.equal(diffLine(0, 1), '1 to unlink');
  assert.equal(diffLine(3, 1), '3 to link, 1 to unlink');
  assert.equal(LINK_LIMIT, 30);
});

test('a toast says how many planned promos a break skipped', () => {
  assert.equal(plannedPromos(0), '');
  assert.equal(plannedPromos(1), ' · 1 planned promo skipped');
  assert.equal(plannedPromos(3), ' · 3 planned promos skipped');
});

test('the demo has a linked pair with no traffic, a past road, and a network with free platform slots', () => {
  const none = snap.roads.find((r) => r.from === 'instagram:ig-solo' && r.to === 'telegram:@movies_ua')!;
  assert.equal(none.count30d, 0);
  assert.ok(none.linkedAt);
  assert.ok(snap.roads.some((r) => r.past && r.blocked));
  const space = snap.resources.filter((r) => r.groupId === 'g-space');
  assert.deepEqual(space.map((r) => r.platform), ['telegram']);
});
