// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Directive, ResourcePause } from '../api/manager';
import {
  activeEffectsOf, columnOf, describeChange, directiveFilterSearch, inboxTarget, matchesFilters, parseDirectiveFilters,
  pausesOf, timeLeft, toggleKind, unscoredReason, verificationChip,
} from './directive-view';

const dir = (over: Partial<Directive> = {}): Directive => ({
  id: 'd1', fromAgentId: 'm', toAgentId: 'o', from: 'manager', to: 'space', kind: 'frequency', binding: 'directive', structural: false,
  body: 'b', params: {}, rationale: null, evidence: null, expected: null, reviewAt: null, status: 'applied', resolution: null, reasonKind: null,
  ownerDecision: null, outcome: null, outcomeDetail: null, deliveredAt: null, appliedAt: null, shadow: false, change: null, execError: null,
  verification: null, verifiedAt: null, contestedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over,
});

test('filters round-trip through the URL and drop unknown values', () => {
  const f = parseDirectiveFilters({ binding: 'advice', kind: 'frequency,bogus,advice' });
  assert.deepEqual(f, { binding: 'advice', kinds: ['advice', 'frequency'] });
  assert.deepEqual(directiveFilterSearch(f), { binding: 'advice', kind: 'advice,frequency' });
  assert.deepEqual(parseDirectiveFilters({ binding: 'nope' }), { binding: undefined, kinds: [] });
  assert.deepEqual(directiveFilterSearch({ kinds: [] }), { binding: undefined, kind: undefined });
  assert.deepEqual(toggleKind({ kinds: ['frequency'] }, 'task').kinds, ['task', 'frequency']);
  assert.deepEqual(toggleKind({ kinds: ['frequency', 'task'] }, 'task').kinds, ['frequency']);
  assert.equal(matchesFilters(dir({ binding: 'advice', kind: 'task' }), { binding: 'directive', kinds: [] }), false);
  assert.equal(matchesFilters(dir({ kind: 'task' }), { kinds: ['task'] }), true);
  assert.equal(matchesFilters(dir({ kind: 'repost' }), { kinds: ['task'] }), false);
});

test('board columns: contested waits for the owner, declined and failed are closed', () => {
  assert.equal(columnOf('contested'), 'awaiting');
  assert.equal(columnOf('awaiting_owner'), 'awaiting');
  assert.equal(columnOf('declined'), 'closed');
  assert.equal(columnOf('failed'), 'closed');
  assert.equal(columnOf('applied'), 'applied');
});

test('verification chip covers checking, verified, not followed, self-reported and not verified', () => {
  assert.equal(verificationChip(dir())?.label, 'applied · checking');
  assert.equal(verificationChip(dir({ verifiedAt: '2026-10-02T00:00:00Z', verification: { kind: 'observed', adherence: 'followed' } }))?.label, 'verified ✓');
  assert.equal(verificationChip(dir({ verification: { kind: 'observed', adherence: 'violated' } }))?.tone, 'danger');
  assert.equal(verificationChip(dir({ binding: 'advice', kind: 'advice', verification: { kind: 'self_reported' } }))?.label, 'self-reported');
  assert.equal(verificationChip(dir({ status: 'evaluated', outcome: 'inconclusive', outcomeDetail: { reason: 'not_verified' } }))?.label, 'not verified');
  assert.equal(verificationChip(dir({ status: 'accepted', change: { op: 'experiment' } }))?.label, 'applying');
  assert.equal(verificationChip(dir({ status: 'new' })), null);
  assert.equal(unscoredReason(dir({ outcomeDetail: { reason: 'not_verified', adherence: 'not_followed' } })), 'not verified — inconclusive · not followed');
  assert.equal(unscoredReason(dir({ outcomeDetail: { reason: 'self_reported' } })), 'self-reported advice — not scored');
  assert.equal(unscoredReason(dir({ outcomeDetail: { changePct: 4 } })), null);
});

test('describeChange renders every executor op', () => {
  assert.equal(describeChange({ op: 'per_day', resource_ref: 'telegram:@space', before: { min: 2, max: 4 }, after: { min: 3, max: 5 } }), 'posts a day 2–4 → 3–5 on telegram:@space');
  assert.equal(describeChange({ op: 'format_weight', format: 'carousel', before: 0.2, after: 0.35 }), 'carousel weight 20% → 35%');
  assert.match(describeChange({ op: 'series_active', series: 'facts', before: true, after: false, resume_on: '2026-10-20' })!, /series “facts” paused until 20 Oct/);
  assert.match(describeChange({ op: 'pause_resource', resource_ref: 'instagram:space', days: 7, until: '2026-10-15T09:00:00Z' })!, /instagram:space paused for 7 d until 15 Oct/);
  assert.match(describeChange({ op: 'experiment', slots: 2, resource_ref: 'telegram:@space', deadline: '2026-10-11T09:00:00Z' })!, /^2 experiment slots on telegram:@space by 11 Oct/);
  assert.equal(describeChange({ op: 'playbook_build', version: 7 }), 'playbook v7 built from the brief · waits for your activation');
  assert.equal(describeChange(null), null);
});

test('active effects: applied changes with a pause series and an open quota; pauses filtered by agent', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const fx = activeEffectsOf([
    dir({ id: 'a', change: { op: 'per_day', target: 'playbook', before: { min: 2, max: 3 }, after: { min: 3, max: 4 }, version: 4 } }),
    dir({ id: 'b', kind: 'pause_series', change: { op: 'series_active', series: 'x', before: true, after: false, resume_on: '2026-10-20' } }),
    dir({ id: 'c', kind: 'pause_series', change: { op: 'series_active', series: 'y', before: true, after: false, resumed_at: '2026-10-07T00:00:00Z' } }),
    dir({ id: 'd', kind: 'experiment', status: 'accepted', change: { op: 'experiment', slots: 1, deadline: '2026-10-10T00:00:00Z' } }),
    dir({ id: 'e', kind: 'pause_resource', change: { op: 'pause_resource', resource_ref: 'instagram:x', until: '2026-10-10T00:00:00Z' } }),
    dir({ id: 'f', status: 'evaluated', change: { op: 'per_day' } }),
    dir({ id: 'g', shadow: true, change: { op: 'per_day' } }),
  ], now);
  assert.deepEqual(fx.map((x) => [x.directive.id, x.kind]), [['a', 'playbook'], ['b', 'series'], ['d', 'experiment']]);
  assert.equal(fx[0].version, 4);

  const p = (over: Partial<ResourcePause>): ResourcePause => ({
    id: 1, resourceRef: 'instagram:x', agentId: 'o', agentHandle: 'space', directiveId: 'e', reason: 'r', startsAt: '', until: '2026-10-10T00:00:00Z',
    liftedAt: null, liftedBy: null, createdAt: '', active: true, ...over,
  });
  assert.equal(pausesOf([p({}), p({ id: 2, agentId: 'z', agentHandle: 'other' }), p({ id: 3, active: false })], { id: 'o', handle: 'space' }).length, 1);
});

test('inbox targets: directive refs open the board, resource pauses open the orchestrator', () => {
  assert.deepEqual(inboxTarget({ kind: 'directive_contested', refType: 'directive', refId: 'x' }, 'space'), { to: 'directive', id: 'x' });
  assert.deepEqual(inboxTarget({ kind: 'resource_paused', refType: 'directive', refId: 'x' }, 'space'), { to: 'directive', id: 'x' });
  assert.deepEqual(inboxTarget({ kind: 'resource_resumed', refType: 'resource', refId: 'instagram:x' }, 'space'), { to: 'pauses', handle: 'space' });
  assert.equal(inboxTarget({ kind: 'resource_unhealthy', refType: 'resource', refId: 'instagram:x' }, 'space'), null);
  assert.equal(inboxTarget({ kind: 'skill_edit', refType: 'skill', refId: '1' }, 'space'), null);
});

test('timeLeft counts down to a pause end', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  assert.equal(timeLeft('2026-10-08T12:20:00Z', now), 'in 20 min');
  assert.equal(timeLeft('2026-10-09T12:00:00Z', now), 'in 24 h');
  assert.equal(timeLeft('2026-10-15T12:00:00Z', now), 'in 7 d');
  assert.equal(timeLeft('2026-10-08T11:00:00Z', now), 'ended');
});
