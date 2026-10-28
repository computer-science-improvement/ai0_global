// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B3.2: the mode explanation under the big switch (kind-aware), what Run now does, and its error texts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followsHint, modeHint, nextPlanLine, runNowError, runNowState } from './mode-hints';
import type { AgentKind } from '../api/agents';
import type { EditorMode } from '../api/types';

const MODES: EditorMode[] = ['off', 'shadow', 'approve', 'live'];
const KINDS: AgentKind[] = ['manager', 'builder', 'auditor', 'orchestrator', 'planner', 'ideator', 'idea_reviewer', 'executor', 'reviewer'];

test('every kind has a distinct line for each of the four modes', () => {
  for (const kind of KINDS) {
    const lines = MODES.map((m) => modeHint(m, { kind }));
    assert.equal(new Set(lines).size, 4, kind);
    for (const l of lines) assert.ok(l.length > 10 && l.length < 120, `${kind}: ${l}`);
  }
});

test('an orchestrator: approval names the evening batch hour and zone, the rest is the prototype copy', () => {
  assert.equal(modeHint('off', { kind: 'orchestrator' }), 'Off — the agent does nothing.');
  assert.equal(modeHint('shadow', { kind: 'orchestrator' }), 'Shadow — plans and writes next to you, publishes nothing.');
  assert.equal(modeHint('live', { kind: 'orchestrator' }), 'Live — publishes on its own through code guards.');
  assert.match(modeHint('approve', { kind: 'orchestrator' }), /at 20:00 and wait for you/, 'defaults to 20:00');
  assert.match(modeHint('approve', { kind: 'orchestrator', batchHour: 19, zone: 'Kyiv' }), /at 19:00 Kyiv and wait for you/);
  assert.match(modeHint('approve', { kind: 'orchestrator', batchHour: null }), /20:00/);
});

test('@manager: Shadow means directives are filed but nothing acts, not "plans and writes"', () => {
  assert.match(modeHint('shadow', { kind: 'manager' }), /directives are filed as previews/);
  assert.doesNotMatch(modeHint('shadow', { kind: 'manager' }), /plans and writes/);
  assert.match(modeHint('off', { kind: 'manager' }), /no scheduled reviews and no new directives/);
  assert.match(modeHint('live', { kind: 'manager' }), /bind the agents/);
  assert.doesNotMatch(modeHint('approve', { kind: 'manager' }), /20:00/, 'the manager has no evening batch');
});

test('builder and sysadmin do not promise posts', () => {
  for (const kind of ['builder', 'auditor'] as const) {
    for (const m of MODES) assert.doesNotMatch(modeHint(m, { kind }), /post|publish/i, `${kind}/${m}`);
  }
});

test('followsHint points at the orchestrator', () => {
  assert.equal(followsHint('space'), 'Runs in the mode of @space. Change it there.');
});

test('Run now: orchestrator and planner replan, reviewer runs, manager has its own run', () => {
  const base = { handle: 'x', paused: false, mode: 'live' as EditorMode };
  assert.deepEqual(runNowState({ ...base, kind: 'orchestrator' }), { show: true, enabled: true, title: 'Replans the rest of today; posts already written stay' });
  assert.equal(runNowState({ ...base, kind: 'planner' }).enabled, true);
  assert.match(runNowState({ ...base, kind: 'reviewer' }).title, /reviewer run/);
  assert.match(runNowState({ ...base, kind: 'manager' }).title, /KPI digest/);
});

test('Run now: kinds that run on their own schedule get no button', () => {
  for (const kind of ['ideator', 'idea_reviewer', 'executor', 'builder', 'auditor'] as const) {
    const s = runNowState({ kind, handle: 'x', paused: false, mode: 'live' });
    assert.equal(s.show, false, kind);
    assert.equal(s.enabled, false, kind);
    assert.match(s.title, /runs on its own schedule/);
  }
});

test('Run now: paused and off are disabled with a reason, not hidden', () => {
  const paused = runNowState({ kind: 'orchestrator', handle: 'x', paused: true, mode: 'live' });
  assert.deepEqual([paused.show, paused.enabled, paused.title], [true, false, 'Resume the agent first']);
  const off = runNowState({ kind: 'orchestrator', handle: 'x', paused: false, mode: 'off' });
  assert.deepEqual([off.show, off.enabled], [true, false]);
  assert.match(off.title, /channel is off/);
  const mgrOff = runNowState({ kind: 'manager', handle: 'manager', paused: false, mode: 'off' });
  assert.match(mgrOff.title, /@manager is off/);
  assert.equal(runNowState({ kind: 'orchestrator', handle: 'x', paused: false, mode: 'shadow' }).enabled, true);
  assert.equal(runNowState({ kind: 'orchestrator', handle: 'x', paused: false, mode: 'approve' }).enabled, true);
});

test('runNowError: the codes of the replan path in English, anything else is left to the server text', () => {
  assert.equal(runNowError('agent_paused', 'space'), '@space is paused — resume it first');
  assert.match(runNowError('channel_off', 'space')!, /channel is off/);
  assert.match(runNowError('replan_in_progress', 'space')!, /already running/);
  assert.match(runNowError('editor_disabled', 'space')!, /switched off on the server/);
  assert.match(runNowError('manager_off', 'manager')!, /@manager is off/);
  assert.match(runNowError('no_manager', 'manager')!, /no @manager/);
  assert.equal(runNowError('something_else', 'space'), null);
  assert.equal(runNowError(undefined, 'space'), null);
});

test('nextPlanLine: the plan hour, or the evening batch in approval mode', () => {
  assert.equal(nextPlanLine({ planHour: 6, approval: false, zone: 'Kyiv' }), 'Next plan at 06:00 Kyiv.');
  assert.equal(nextPlanLine({ planHour: 6, approval: true, batchHour: 20, zone: 'Kyiv' }), 'Next plan at 20:00 Kyiv.');
  assert.equal(nextPlanLine({ planHour: 9, approval: true }), 'Next plan at 20:00.');
  assert.equal(nextPlanLine({ planHour: 9, approval: false }), 'Next plan at 09:00.');
});
