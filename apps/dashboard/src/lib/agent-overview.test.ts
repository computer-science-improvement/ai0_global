// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B3: the words and counts of the pause banners and (B3.3) the Overview's day list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAUSE_CAUSE, capPauses, pauseEffect, pauseSummary, pauseTitle, zoneLabel } from './agent-overview';

test('pauseTitle: a series, a fixed-slot rule, or the whole resource', () => {
  assert.equal(pauseTitle({ key: 'series:abc', label: 'Space facts' }), 'Series “Space facts” paused');
  assert.equal(pauseTitle({ key: 'series:abc', label: '  ' }), 'A series is paused');
  assert.equal(pauseTitle({ key: 'rule:r1', label: 'fixed slot 09:00 · Weather' }), 'Fixed slot 09:00 · Weather paused');
  assert.equal(pauseTitle({ key: 'rule:r1', label: 'Fixed slot 09:00' }), 'Fixed slot 09:00 paused');
  assert.equal(pauseTitle({ key: 'rule:r1', label: '' }), 'A fixed slot is paused');
  assert.equal(pauseTitle({ key: 'resource:telegram:x', label: 'anything' }), 'Planning paused');
  assert.equal(pauseTitle({ key: 'weird', label: 'x' }), 'Planning paused');
});

test('pauseSummary: the cause, and the streak only when there is one', () => {
  assert.equal(pauseSummary({ cause: 'no_material', streak: 3 }), 'No material: 3 skips in a row');
  assert.equal(pauseSummary({ cause: 'source_unreachable', streak: 1 }), 'Source unreachable: 1 skip in a row');
  assert.equal(pauseSummary({ cause: 'owner', streak: 0 }), 'Paused by you', 'an owner pause has no streak');
  assert.equal(pauseSummary({ cause: 'something_new', streak: 0 }), 'something_new');
  for (const c of Object.keys(PAUSE_CAUSE)) assert.ok(PAUSE_CAUSE[c as keyof typeof PAUSE_CAUSE].length > 3);
});

test('pauseEffect and zoneLabel', () => {
  assert.match(pauseEffect('series:a'), /planned slots are skipped at no cost/);
  assert.match(pauseEffect('rule:a'), /fixed slot is skipped/);
  assert.match(pauseEffect('resource:telegram:x'), /Nothing is planned here/);
  assert.equal(zoneLabel('Europe/Kyiv'), 'Kyiv');
  assert.equal(zoneLabel('America/New_York'), 'New York');
  assert.equal(zoneLabel('UTC'), 'UTC');
  assert.equal(zoneLabel(null), null);
  assert.equal(zoneLabel(''), null);
});

test('capPauses: three banners, the rest behind Show all', () => {
  const five = [1, 2, 3, 4, 5];
  assert.deepEqual(capPauses(five, false), { shown: [1, 2, 3], hidden: 2 });
  assert.deepEqual(capPauses(five, true), { shown: five, hidden: 0 });
  assert.deepEqual(capPauses([1, 2, 3], false), { shown: [1, 2, 3], hidden: 0 });
  assert.deepEqual(capPauses([], false), { shown: [], hidden: 0 });
  assert.deepEqual(capPauses(five, false, 1), { shown: [1], hidden: 4 });
});
