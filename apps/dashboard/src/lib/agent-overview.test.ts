// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B3: the words and counts of the pause banners, the KPI counters, the Overview's day list and the lock rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAUSE_CAUSE, RUN_MARK, RUN_STATUS_LABEL, SUMMARY_FIELDS, adviceCounts, buildSteps, capPauses, daySummary, formatRows, lockSummary,
  nowIndex, pauseEffect, pauseSummary, pauseTitle, planAtLine, stepWindow, toggleLock,
} from './agent-overview';
import type { AgentRun, SeriesPause } from '../api/agents';
import type { PlanSlot } from '../api/network';

// ── pause banners ────────────────────────────────────────────────────────────

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

test('pauseEffect: what a pause means for planning', () => {
  assert.match(pauseEffect('series:a'), /planned slots are skipped at no cost/);
  assert.match(pauseEffect('rule:a'), /fixed slot is skipped/);
  assert.match(pauseEffect('resource:telegram:x'), /Nothing is planned here/);
});

test('capPauses: three banners, the rest behind Show all', () => {
  const five = [1, 2, 3, 4, 5];
  assert.deepEqual(capPauses(five, false), { shown: [1, 2, 3], hidden: 2 });
  assert.deepEqual(capPauses(five, true), { shown: five, hidden: 0 });
  assert.deepEqual(capPauses([1, 2, 3], false), { shown: [1, 2, 3], hidden: 0 });
  assert.deepEqual(capPauses([], false), { shown: [], hidden: 0 });
  assert.deepEqual(capPauses(five, false, 1), { shown: [1], hidden: 4 });
});

// ── KPI counters ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-29T12:00:00Z');
const dir = (status: string, over: Partial<{ binding: string; shadow: boolean; createdAt: string }> = {}) =>
  ({ binding: 'advice', status, shadow: false, createdAt: '2026-10-20T10:00:00Z', ...over });

test('adviceCounts: followed = accepted, applied, evaluated; declined; shadow, directives and old advice are left out', () => {
  const ds = [
    dir('accepted'), dir('applied'), dir('evaluated'), dir('declined'), dir('declined'),
    dir('new'), dir('awaiting_owner'), dir('rejected'), dir('failed'),
    dir('accepted', { shadow: true }), dir('declined', { shadow: true }),
    dir('accepted', { binding: 'directive' }),
    dir('accepted', { createdAt: '2026-09-01T10:00:00Z' }),
  ];
  assert.deepEqual(adviceCounts(ds, NOW), { followed: 3, declined: 2 });
  assert.deepEqual(adviceCounts([], NOW), { followed: 0, declined: 0 });
  assert.deepEqual(adviceCounts([dir('accepted', { createdAt: '2026-09-01T10:00:00Z' })], NOW, 90), { followed: 1, declined: 0 }, 'a longer window counts it');
});

test('planAtLine: the plan hour, or the evening batch in approval mode', () => {
  assert.equal(planAtLine({ planHour: 6, approval: false, zone: 'Kyiv' }), 'Plans daily at 06:00 Kyiv');
  assert.equal(planAtLine({ planHour: 6, approval: true, batchHour: 19, zone: 'Kyiv' }), 'Plans at 19:00 Kyiv, the evening before');
  assert.equal(planAtLine({ planHour: 6, approval: true }), 'Plans at 20:00, the evening before');
});

// ── Today, step by step ──────────────────────────────────────────────────────

const TZ = 'Europe/Kyiv';
const DAY = '2026-10-29';
// Kyiv is UTC+2 on 29 Oct 2026 (summer time ended on the 25th): 07:00Z = 09:00.
const at = (hhmmKyiv: string) => {
  const [h, m] = hhmmKyiv.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 29, h - 2, m)).toISOString();
};

const slot = (id: string, time: string, over: Partial<PlanSlot> = {}): PlanSlot => ({
  id, at: at(time), kind: 'content', format: 'text', topic: `Topic ${id}`, angle: null, status: 'planned', error: null, preview: null,
  resourceRef: 'telegram:x', ideaId: null, runId: null, ...over,
});
const run = (id: string, time: string, over: Partial<AgentRun> = {}): AgentRun => ({
  id, role: 'planner', channelKey: 'x', slotId: null, model: 'm', status: 'ok', steps: 4, promptTokens: 0, completionTokens: 0, costUsd: 0.0123,
  error: null, startedAt: at(time), finishedAt: at(time), agentId: 'a1', ...over,
});
const pause = (id: string, time: string, over: Partial<SeriesPause> = {}): SeriesPause => ({
  id, key: 'series:s1', label: 'Space facts', cause: 'no_material', reason: '', streak: 3, pausedAt: at(time), resumedAt: null, resumedBy: null, ...over,
});

test('buildSteps: slots, runs and pauses of the day in time order, with the HH:MM of the channel zone', () => {
  const steps = buildSteps({
    slots: [slot('s2', '18:00'), slot('s1', '09:00', { status: 'published' })],
    runs: [run('r1', '06:02')],
    pauses: [pause('p1', '12:30')],
    planRunId: 'r1', day: DAY, tz: TZ,
  });
  assert.deepEqual(steps.map((s) => [s.time, s.kind, s.title]), [
    ['06:02', 'run', 'Planned the day'],
    ['09:00', 'slot', 'Topic s1'],
    ['12:30', 'pause', 'Series “Space facts” paused'],
    ['18:00', 'slot', 'Topic s2'],
  ]);
  assert.equal(steps[0].meta, '2 slots · 4 steps · $0.01');
  assert.equal(steps[0].link?.kind, 'run');
  assert.deepEqual(steps[1].link, { kind: 'slot', id: 's1' });
  assert.equal(steps[2].link, null);
});

test('buildSteps: the plan-making run is named, another run uses its role; a slot run is not listed twice', () => {
  const steps = buildSteps({
    slots: [slot('s1', '09:00', { status: 'published', runId: 'r-exec' })],
    runs: [run('r-plan', '06:00'), run('r-exec', '09:00', { role: 'executor' }), run('r-slot', '09:01', { role: 'executor', slotId: 's1' }), run('r-rev', '10:00', { role: 'idea_reviewer' })],
    pauses: [], planRunId: 'r-plan', day: DAY, tz: TZ,
  });
  assert.deepEqual(steps.map((s) => s.title), ['Planned the day', 'Topic s1', 'Idea reviewer run']);
});

test('buildSteps: yesterday’s runs and pauses are dropped; a run 23:30 Kyiv stays on the day it started in the channel zone', () => {
  const steps = buildSteps({
    slots: [],
    runs: [run('old', '10:00', { startedAt: '2026-10-28T08:00:00Z' }), run('late', '23:30')],
    pauses: [pause('pold', '10:00', { pausedAt: '2026-10-28T08:00:00Z' })],
    day: DAY, tz: TZ,
  });
  assert.deepEqual(steps.map((s) => s.key), ['run:late']);
});

test('buildSteps: a missed series slot says so and names why; a superseded one is a plain skip', () => {
  const steps = buildSteps({
    slots: [
      slot('m', '09:00', { status: 'skipped', seriesName: 'Daily fact', error: 'skipped by agent: no_material: nothing new today' }),
      slot('sup', '10:00', { status: 'skipped', seriesName: 'Daily fact', error: 'superseded by a new plan' }),
      slot('own', '11:00', { status: 'skipped', seriesName: 'Daily fact', error: 'rejected by owner' }),
      slot('plain', '12:00', { status: 'skipped', error: 'no_fresh_item: feeds empty' }),
    ],
    runs: [], pauses: [], day: DAY, tz: TZ,
  });
  const by = Object.fromEntries(steps.map((s) => [s.key, s]));
  assert.equal(by['slot:m'].mark, 'missed');
  assert.equal(by['slot:m'].title, '“Daily fact” missed');
  assert.equal(by['slot:m'].note, 'Skipped by the agent — no material — nothing new today');
  assert.equal(by['slot:sup'].mark, 'skipped', 'a replan is not a miss');
  assert.equal(by['slot:sup'].note, 'Replaced by a newer plan');
  assert.equal(by['slot:own'].mark, 'skipped', 'the owner’s own decision is not a miss');
  assert.equal(by['slot:plain'].mark, 'skipped');
  assert.equal(by['slot:plain'].note, 'Nothing fresh in the sources — feeds empty');
});

test('buildSteps: a pinned slot counts as a rule for the miss test; awaiting approval asks for the owner; a good slot has no note', () => {
  const steps = buildSteps({
    slots: [
      slot('pin', '09:00', { status: 'failed', pinned: true, error: 'resource_unavailable: bot kicked' }),
      slot('ap', '10:00', { status: 'awaiting_approval' }),
      slot('ok', '11:00', { status: 'published' }),
      slot('res', '12:00', { kind: 'reserved', topic: '' }),
    ],
    runs: [], pauses: [], day: DAY, tz: TZ,
  });
  assert.equal(steps[0].mark, 'missed');
  assert.equal(steps[0].title, 'A pinned post missed');
  assert.equal(steps[0].note, 'Connection broken — bot kicked');
  assert.equal(steps[1].note, 'Waiting for your approval');
  assert.equal(steps[2].note, null);
  assert.equal(steps[3].title, 'Reserved slot');
});

test('buildSteps: run statuses map to marks and words; an error run carries its error', () => {
  const steps = buildSteps({
    slots: [],
    runs: [run('a', '08:00', { status: 'ok' }), run('b', '08:10', { status: 'error', error: 'timeout' }), run('c', '08:20', { status: 'running' }), run('d', '08:30', { status: 'max_steps' })],
    pauses: [], day: DAY, tz: TZ,
  });
  assert.deepEqual(steps.map((s) => s.mark), ['approved', 'failed', 'running', 'expired']);
  assert.deepEqual(steps.map((s) => s.markLabel), ['Finished', 'Failed', 'Running', 'Stopped: out of steps']);
  assert.equal(steps[1].note, 'timeout');
  assert.equal(steps[0].note, null);
  for (const st of Object.keys(RUN_MARK)) assert.ok(RUN_STATUS_LABEL[st as keyof typeof RUN_STATUS_LABEL], st);
});

test('buildSteps: an empty day is an empty list', () => {
  assert.deepEqual(buildSteps({ slots: [], runs: [], pauses: [], day: DAY, tz: TZ }), []);
});

test('nowIndex: the divider goes before the first step still to come', () => {
  const steps = buildSteps({ slots: [slot('a', '09:00'), slot('b', '12:00'), slot('c', '18:00')], runs: [], pauses: [], day: DAY, tz: TZ });
  const kyiv = (hhmm: string) => new Date(at(hhmm));
  assert.equal(nowIndex(steps, kyiv('08:00')), 0);
  assert.equal(nowIndex(steps, kyiv('10:00')), 1);
  assert.equal(nowIndex(steps, kyiv('18:00')), 3, 'a step exactly now is behind us');
  assert.equal(nowIndex(steps, kyiv('23:00')), 3);
  assert.equal(nowIndex([], kyiv('10:00')), 0);
});

test('stepWindow: the whole list when it fits, else a window around now that stays inside the list', () => {
  assert.deepEqual(stepWindow(10, 5), { start: 0, end: 10 });
  assert.deepEqual(stepWindow(14, 14), { start: 0, end: 14 });
  assert.deepEqual(stepWindow(30, 0), { start: 0, end: 14 });
  assert.deepEqual(stepWindow(30, 10), { start: 6, end: 20 });
  assert.deepEqual(stepWindow(30, 30), { start: 16, end: 30 }, 'the day is over: the last rows');
  assert.deepEqual(stepWindow(0, 0), { start: 0, end: 0 });
});

test('daySummary: slots by mark in the legend order, runs and pauses are not counted', () => {
  const steps = buildSteps({
    slots: [slot('a', '09:00', { status: 'published' }), slot('b', '10:00', { status: 'published' }), slot('c', '12:00'), slot('d', '13:00', { status: 'skipped', seriesName: 'S', error: 'skipped by agent: quality: weak' })],
    runs: [run('r', '06:00')], pauses: [pause('p', '07:00')], day: DAY, tz: TZ,
  });
  assert.equal(daySummary(steps), '1 planned · 2 published · 1 missed');
  assert.equal(daySummary([]), '');
});

// ── How posts look ───────────────────────────────────────────────────────────

test('formatRows: the four fields in order, set or not, locked or not', () => {
  const rows = formatRows({ hashtags: { count: 3, fixed: [] }, links: 'inline', preferred_formats: ['text', 'photo'] }, ['links', 'tone']);
  assert.deepEqual(rows.map((r) => r.field), [...SUMMARY_FIELDS]);
  assert.deepEqual(rows.map((r) => r.label), ['Hashtags', 'Links', 'Emoji', 'Preferred formats']);
  assert.deepEqual(rows.map((r) => r.value), ['3', 'in the text', null, 'text, photo']);
  assert.deepEqual(rows.map((r) => r.locked), [false, true, false, false]);
  assert.deepEqual(formatRows({}, []).map((r) => r.value), [null, null, null, null], 'a resource with nothing set');
});

test('toggleLock: adds a field, removes it, keeps the rest in order', () => {
  assert.deepEqual(toggleLock([], 'links'), ['links']);
  assert.deepEqual(toggleLock(['tone', 'links'], 'links'), ['tone']);
  assert.deepEqual(toggleLock(['tone'], 'emoji'), ['tone', 'emoji']);
});

test('lockSummary', () => {
  assert.equal(lockSummary(3, 2), 'at most 3 changes a day · 2 locked');
  assert.equal(lockSummary(1, 0), 'at most 1 change a day · 0 locked');
});
