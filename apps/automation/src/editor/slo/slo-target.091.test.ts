/** Spec 091 FR-001 / FR-002: the day's target and the channel state (pure). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyTarget, sloState, type StateInput } from './slo-target';
import { SLO_STATES } from './types';
import { SETTINGS } from '../../settings/catalog';

const T = { capacityLeft: 10, published: 0, plannedAhead: 0 };

test('target: card min, clipped into the playbook range, minus owner-paused series', () => {
  assert.deepEqual(dailyTarget({ ...T, cardMin: 2 }), { target: 2, held: false, reason: null });
  assert.equal(dailyTarget({ ...T, cardMin: 2, playbookPerDay: { min: 3, max: 5 } }).target, 3, 'the playbook raises a low card min');
  assert.equal(dailyTarget({ ...T, cardMin: 6, playbookPerDay: { min: 1, max: 3 } }).target, 3, 'and caps a high one');
  assert.equal(dailyTarget({ ...T, cardMin: 3, ownerPausedSlots: 1 }).target, 2);
  assert.equal(dailyTarget({ ...T, cardMin: 1, ownerPausedSlots: 5 }).target, 0);
});

test('target: held channels owe nothing', () => {
  assert.deepEqual(dailyTarget({ ...T, cardMin: 3, heldReason: 'mode is shadow' }), { target: 0, held: true, reason: 'mode is shadow' });
});

test('target: a late start owes only what fits, but a later cap never lowers the morning target', () => {
  const late = dailyTarget({ cardMin: 3, capacityLeft: 1, published: 0, plannedAhead: 0 });
  assert.equal(late.target, 1);
  assert.match(late.reason!, /only 1 of 3/);
  const evening = dailyTarget({ cardMin: 3, capacityLeft: 0, published: 1, plannedAhead: 0, previousTarget: 3 });
  assert.equal(evening.target, 3, 'the day stays short, not met');
  assert.equal(dailyTarget({ cardMin: 2, capacityLeft: 0, published: 0, plannedAhead: 0, previousTarget: 3 }).target, 2,
    'a lower base (the owner changed the card) still applies');
});

const now = new Date('2026-11-07T15:00:00Z');
const S = (o: Partial<StateInput> = {}): StateInput => ({
  target: 3, held: false, published: 0, plannedAhead: 0, capacityLeft: 5, recovering: false, ladderExhausted: false,
  lastPostAt: new Date(now.getTime() - 3_600_000), activeSince: null, darkHours: 24, now, ...o,
});

test('state: every state and the precedence', () => {
  assert.equal(sloState(S({ held: true, heldReason: 'off' })).state, 'held');
  assert.equal(sloState(S({ published: 3 })).state, 'met');
  assert.equal(sloState(S({ published: 1, plannedAhead: 2 })).state, 'on_track');
  assert.equal(sloState(S({ published: 1, plannedAhead: 1 })).state, 'behind');
  assert.equal(sloState(S({ published: 1, plannedAhead: 1, recovering: true })).state, 'recovering');
  assert.equal(sloState(S({ published: 1, ladderExhausted: true })).state, 'starved');
  assert.match(sloState(S({ published: 1, capacityLeft: 0 })).reason!, /no room left/);
});

test('state: dark wins over the counts, held wins over dark; a never-posted channel is dark after it became active', () => {
  const old = new Date(now.getTime() - 30 * 3_600_000);
  const dark = sloState(S({ lastPostAt: old, plannedAhead: 3 }));
  assert.equal(dark.state, 'dark');
  assert.equal(dark.darkSince?.toISOString(), new Date(old.getTime() + 24 * 3_600_000).toISOString());
  assert.match(dark.reason!, /no post for 30 h/);
  assert.equal(sloState(S({ lastPostAt: old, held: true })).state, 'held');
  assert.equal(sloState(S({ lastPostAt: null, activeSince: old })).state, 'dark');
  assert.equal(sloState(S({ lastPostAt: null, activeSince: null })).state, 'behind', 'no clock, no dark');
  assert.notEqual(sloState(S({ lastPostAt: old, published: 1 })).state, 'dark', 'a post today is not dark');
});

test('every state is in the migration CHECK set; the SLO settings exist', () => {
  assert.deepEqual([...SLO_STATES].sort(), ['behind', 'dark', 'held', 'met', 'on_track', 'recovering', 'starved']);
  const keys = new Set(SETTINGS.map((s) => s.key));
  for (const k of ['SLO_CONTROLLER', 'SLO_DARK_HOURS', 'SLO_MAX_RECOVERY_RUNS_PER_DAY', 'SLO_REPLACEMENT_LEAD_MIN', 'SLO_WIDEN_MAX_HOURS', 'SLO_EVERGREEN_DARK_MAX']) {
    assert.ok(keys.has(k), k);
  }
});
