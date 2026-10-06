// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRate, fmtWait, switchSummary, waitingChoiceLabel } from './approval-stats';

test('rates and waits', () => {
  assert.equal(fmtRate(null), '—');
  assert.equal(fmtRate(0.857), '86%');
  assert.equal(fmtRate(1), '100%');
  assert.equal(fmtWait(null), '—');
  assert.equal(fmtWait(42), '42s');
  assert.equal(fmtWait(720), '12 min');
  assert.equal(fmtWait(3 * 3600), '3 h');
  assert.equal(fmtWait(3.5 * 3600), '3.5 h');
  assert.equal(fmtWait(2.1 * 86_400), '2.1 d');
});

test('the waiting-posts choice names what stays for a manual look', () => {
  assert.equal(waitingChoiceLabel(1, 0), 'Also approve the 1 waiting post');
  assert.equal(waitingChoiceLabel(6, 2), 'Also approve the 4 waiting posts (2 posts with warnings stay for a manual look)');
});

test('switch toast', () => {
  const base = { changed: true, approved: 0, skippedWithWarnings: 0, conflicts: 0, leftWaiting: 0 };
  assert.equal(switchSummary({ ...base, to: 'approve' }, 'Космос'), 'Космос is back in approval mode — the next written post waits for you');
  assert.equal(switchSummary({ ...base, to: 'live', approved: 5, skippedWithWarnings: 1, leftWaiting: 1 }, 'Космос'),
    'Космос is Live — agents publish without approval; 5 waiting posts approved; 1 post with warnings left waiting');
  assert.equal(switchSummary({ ...base, to: 'live', leftWaiting: 3 }, 'Космос'), 'Космос is Live — agents publish without approval; 3 posts left waiting');
  assert.equal(switchSummary({ ...base, to: 'live', changed: false }, 'Космос'), 'Космос is already Live');
});
