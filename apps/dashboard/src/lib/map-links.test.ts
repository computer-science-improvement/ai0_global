import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from './map-demo';
import {
  LINK_LIMIT, diffLine, isCurrentRoad, linkChoices, linkDiff, linkHint, linkSections, memberOutcome, memberSections, networkMates, networkMembers,
  pastRoadCount, plannedPromos, promoPartners, stoppedPartners, visibleRoads,
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

// ── T4: the Members picker ──

const rowsOf = (groupId: string, checked: string[], query = '') =>
  memberSections(snap, groupId, new Set(checked), query).flatMap((s) => s.items.map((i) => [i.res.ref, i.member, i.blockedBy?.ref ?? null] as const));

test('network members are listed A–Z', () => {
  const titles = networkMembers(snap, 'g-food').map((r) => r.title ?? r.ref);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(refs(networkMembers(snap, 'g-food')), ['instagram:ig-food', 'telegram:@recipes_ua', 'tiktok:tt-food']);
  assert.deepEqual(networkMembers(snap, 'nope'), []);
});

test('the Members picker offers the members and the resources in no network, never one of another network', () => {
  const rows = rowsOf('g-space', ['telegram:@space_ua']);
  const offered = rows.map(([ref]) => ref).sort();
  assert.deepEqual(offered, ['facebook:fb-old', 'instagram:ig-solo', 'telegram:@gaming_ua', 'telegram:@movies_ua', 'telegram:@space_ua']);
  assert.ok(!offered.includes('instagram:ig-tech'));
  assert.deepEqual(memberSections(snap, 'g-space', new Set(), '').map((s) => s.title), ['Telegram channels', 'Instagram', 'Facebook pages']);
});

test('one place per platform: a checked resource blocks the other rows of its platform, and says which one holds it', () => {
  // Space has only Telegram: the other Telegram channels are blocked by it, the free platforms are not
  const rows = rowsOf('g-space', ['telegram:@space_ua']);
  assert.deepEqual(rows.find(([r]) => r === 'telegram:@movies_ua'), ['telegram:@movies_ua', false, 'telegram:@space_ua']);
  assert.deepEqual(rows.find(([r]) => r === 'instagram:ig-solo'), ['instagram:ig-solo', false, null]);
  assert.deepEqual(rows.find(([r]) => r === 'telegram:@space_ua'), ['telegram:@space_ua', true, null]);
  // unchecking the holder frees the place
  assert.equal(rowsOf('g-space', []).find(([r]) => r === 'telegram:@movies_ua')![2], null);
  // checking a free-platform resource does not block anything else
  const withSolo = rowsOf('g-space', ['telegram:@space_ua', 'instagram:ig-solo']);
  assert.equal(withSolo.find(([r]) => r === 'instagram:ig-solo')![2], null);
  assert.equal(withSolo.find(([r]) => r === 'facebook:fb-old')![2], null);
  // a full network blocks every unnetworked row of its platforms
  const tech = rowsOf('g-tech', networkMembers(snap, 'g-tech').map((r) => r.ref));
  assert.equal(tech.find(([r]) => r === 'instagram:ig-solo')![2], 'instagram:ig-tech');
  assert.equal(tech.find(([r]) => r === 'facebook:fb-old')![2], 'facebook:fb-tech');
});

test('members come first inside a platform, and the picker filters on title, handle and ref', () => {
  const tg = memberSections(snap, 'g-space', new Set(), '')[0].items.map((i) => i.res.ref);
  assert.equal(tg[0], 'telegram:@space_ua');
  assert.deepEqual(rowsOf('g-space', [], 'movies').map(([r]) => r), ['telegram:@movies_ua']);
  assert.deepEqual(rowsOf('g-space', [], 'zzzz'), []);
});

test('a partial success: what went through, what was refused', () => {
  const out = memberOutcome(
    [{ ref: 'a', ok: true }, { ref: 'b', ok: false, error: 'already has a Telegram channel' }, { ref: 'c', ok: true }, { ref: 'd', ok: false }],
    ['a', 'b'], ['c', 'd'],
  );
  assert.deepEqual(out.added, ['a']);
  assert.deepEqual(out.removed, ['c']);
  assert.deepEqual(out.failed, [{ ref: 'b', error: 'already has a Telegram channel' }, { ref: 'd', error: 'failed' }]);
});

// ── T4: link mode ──

test('link mode: a free place in the first one\'s network offers to put the second one in it', () => {
  const free = linkChoices(snap, 'telegram:@space_ua', 'instagram:ig-solo')!;
  assert.deepEqual(free.putIn, { id: 'g-space', name: 'Space' });
  assert.equal(free.full, null);
  assert.equal(free.leaves, null);
  assert.equal(free.linked, false);

  // the second one is in another network: it would leave it
  assert.equal(linkChoices(snap, 'telegram:@space_ua', 'facebook:fb-tech')!.leaves, 'Tech & Science');

  // a taken place is not offered, and the holder is named
  const taken = linkChoices(snap, 'telegram:@ai0_global', 'instagram:ig-solo')!;
  assert.equal(taken.putIn, null);
  assert.equal(taken.full?.holder.ref, 'instagram:ig-tech');

  // already in the same network: nothing to put
  const same = linkChoices(snap, 'telegram:@ai0_global', 'facebook:fb-tech')!;
  assert.equal(same.putIn, null);
  assert.equal(same.full, null);
});

test('link mode: no network on the first one means promo partners only; already linked and stopped pairs are flagged', () => {
  const none = linkChoices(snap, 'telegram:@movies_ua', 'telegram:@gaming_ua')!;
  assert.equal(none.putIn, null);
  assert.equal(none.full, null);
  assert.equal(none.stopped, true);
  assert.equal(none.linked, false);
  assert.equal(linkChoices(snap, 'telegram:@ai0_global', 'telegram:@space_ua')!.linked, true);
  assert.equal(linkChoices(snap, 'telegram:@ai0_global', 'telegram:@ai0_global'), null);
  assert.equal(linkChoices(snap, 'telegram:@ai0_global', 'telegram:@nope'), null);
});

test('the hint under the HUD asks for the first, then the second building', () => {
  assert.match(linkHint(null), /click a building, then another/);
  assert.match(linkHint('AI0 Global'), /Now click .* with AI0 Global/);
  assert.match(linkHint(null), /Esc/);
});
