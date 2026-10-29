// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B1: the pure logic of Today (/app).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_ROWS, AXIS_END_MIN, AXIS_START_MIN, MARKER_SPAN_MIN, NEEDS_ROWS, activeSlots, axisMinutes, axisPct, bucketOf, buildLanes, busiestChannel, capState,
  greetingFor, healthLabel, inboxLinkCount, kyivEyebrow, kyivGreeting, laneHeight, laneMarkers, legendMarks, metaFollowersLine, needsHeadline,
  needsSummary, nowLine, openNotes, orchestratorsByChannel, otherPlatformCount, pastPct, reconnectCount, recentEvents, ringArcs, shorten, signed,
  sortNotes, summarizeDay, systemAgents, telegramSlots,
  type DayPlan, type DaySlot, type NoteLike,
} from './today';

const note = (id: number, severity: NoteLike['severity'], createdAt = '2026-10-28T10:00:00.000Z', readAt: string | null = null): NoteLike =>
  ({ id, severity, createdAt, readAt });

test('greetingFor: morning from 05:00, afternoon from 12:00, evening from 18:00 through the night', () => {
  assert.equal(greetingFor(5), 'Good morning');
  assert.equal(greetingFor(11), 'Good morning');
  assert.equal(greetingFor(12), 'Good afternoon');
  assert.equal(greetingFor(17), 'Good afternoon');
  assert.equal(greetingFor(18), 'Good evening');
  assert.equal(greetingFor(23), 'Good evening');
  assert.equal(greetingFor(0), 'Good evening');
  assert.equal(greetingFor(4), 'Good evening');
});

test('the greeting and the eyebrow follow the Kyiv clock, not the machine', () => {
  // 2026-10-28 19:51 UTC is 21:51 in Kyiv (EET, UTC+2 after the clocks went back on 25 Oct).
  const at = new Date('2026-10-28T19:51:00.000Z');
  assert.equal(kyivEyebrow(at), 'Wed, 28 Oct · Kyiv 21:51');
  assert.equal(kyivGreeting(at), 'Good evening');
  // 04:30 UTC is 06:30 in Kyiv: morning there.
  assert.equal(kyivGreeting(new Date('2026-10-28T04:30:00.000Z')), 'Good morning');
  // 22:30 UTC is already the next day in Kyiv.
  assert.equal(kyivEyebrow(new Date('2026-10-28T22:30:00.000Z')), 'Thu, 29 Oct · Kyiv 00:30');
});

test('needsHeadline: none, one, many', () => {
  assert.equal(needsHeadline(0), 'Nothing needs you.');
  assert.equal(needsHeadline(-3), 'Nothing needs you.');
  assert.equal(needsHeadline(1), '1 thing needs you.');
  assert.equal(needsHeadline(4), '4 things need you.');
});

test('sortNotes: critical, action, FYI; newest first inside a severity; the input is not mutated', () => {
  const input = [
    note(1, 'info', '2026-10-28T12:00:00.000Z'),
    note(2, 'action', '2026-10-28T09:00:00.000Z'),
    note(3, 'critical', '2026-10-28T08:00:00.000Z'),
    note(4, 'action', '2026-10-28T11:00:00.000Z'),
    note(5, 'critical', '2026-10-28T10:00:00.000Z'),
  ];
  const copy = input.map((n) => n.id);
  assert.deepEqual(sortNotes(input).map((n) => n.id), [5, 3, 4, 2, 1]);
  assert.deepEqual(input.map((n) => n.id), copy);
});

test('sortNotes: an unknown severity sorts as FYI, equal times fall back to the newer id', () => {
  const odd = { ...note(9, 'info'), severity: 'urgent' as unknown as NoteLike['severity'] };
  assert.deepEqual(sortNotes([odd, note(1, 'action')]).map((n) => n.id), [1, 9]);
  assert.deepEqual(sortNotes([note(1, 'action'), note(2, 'action')]).map((n) => n.id), [2, 1]);
});

test('openNotes: unread critical and action only, minus the ones dismissed on this page', () => {
  const notes = [
    note(1, 'critical'), note(2, 'action'), note(3, 'info'), note(4, 'critical', undefined, '2026-10-28T11:00:00.000Z'), note(5, 'action'),
  ];
  // Same time for 2 and 5: the newer id first.
  assert.deepEqual(openNotes(notes).map((n) => n.id), [1, 5, 2]);
  assert.deepEqual(openNotes(notes, new Set([2])).map((n) => n.id), [1, 5]);
  assert.deepEqual(openNotes(null), []);
  assert.deepEqual(openNotes(undefined), []);
});

test('needsSummary: critical and action notes + posts to approve + chat cards; FYI and read notes are not counted', () => {
  const notes = [note(1, 'critical'), note(2, 'critical'), note(3, 'action'), note(4, 'info'), note(5, 'action', undefined, '2026-10-28T11:00:00.000Z')];
  assert.deepEqual(needsSummary({ notes, approvals: 3, chatCards: 1 }), { critical: 2, toAct: 5, total: 7 });
  assert.deepEqual(needsSummary({ notes, approvals: 0, chatCards: 0 }), { critical: 2, toAct: 1, total: 3 });
  assert.deepEqual(needsSummary({ notes: [], approvals: 0, chatCards: 0 }), { critical: 0, toAct: 0, total: 0 });
  // A dismissed note leaves the count at once (before the list refetches).
  assert.equal(needsSummary({ notes, approvals: 0, chatCards: 0, hidden: new Set([1]) }).total, 2);
  // Missing or negative counts do not subtract.
  assert.equal(needsSummary({ notes: undefined, approvals: -2, chatCards: -1 }).total, 0);
});

test('inboxLinkCount: every unread note plus the posts to approve (the menu counter)', () => {
  const notes = [note(1, 'critical'), note(2, 'info'), note(3, 'action', undefined, '2026-10-28T11:00:00.000Z')];
  assert.equal(inboxLinkCount(notes, 3), 5);
  assert.equal(inboxLinkCount(notes, 0, new Set([2])), 1);
  assert.equal(inboxLinkCount(undefined, 0), 0);
});

test('shorten: one line, cut with an ellipsis', () => {
  assert.equal(shorten('  a   b\nc '), 'a b c');
  assert.equal(shorten('x'.repeat(10), 10), 'x'.repeat(10));
  assert.equal(shorten('x'.repeat(11), 10), `${'x'.repeat(9)}…`);
  assert.ok(NEEDS_ROWS >= 1);
});

// ── the day ──────────────────────────────────────────────────────────────────

const DAY = '2026-10-28';
/** An ISO instant for a Kyiv wall-clock time on DAY (EET, UTC+2). `dayOffset` 1 is the next calendar day. */
const kyiv = (hh: number, mm: number, dayOffset = 0): string => new Date(Date.UTC(2026, 9, 28 + dayOffset, hh - 2, mm)).toISOString();

let seq = 0;
const slot = (at: string, status = 'planned', extra: Partial<DaySlot> = {}): DaySlot => ({
  id: `s${String(++seq).padStart(3, '0')}`, channelKey: '@ai_global', scheduledAt: at, kind: 'content', status, topic: 'A topic', error: null, ...extra,
});
const plan = (slots: DaySlot[], status = 'active', channelKey = '@ai_global'): DayPlan => ({ channelKey, status, slots });

test('axisPct: 06:00 is 0, 15:00 is 50, 24:00 is 100; outside the axis it clamps', () => {
  assert.equal(AXIS_START_MIN, 360);
  assert.equal(AXIS_END_MIN, 1440);
  assert.equal(axisPct(360), 0);
  assert.equal(axisPct(900), 50);
  assert.equal(axisPct(1440), 100);
  assert.equal(axisPct(120), 0);
  assert.equal(axisPct(1500), 100);
  assert.equal(axisPct(720), 33.33);
});

test('activeSlots: a superseded plan is hidden, even when its slots are all skipped', () => {
  const old = plan([slot(kyiv(9, 0), 'skipped', { error: 'superseded by a new plan' })], 'superseded');
  const live = plan([slot(kyiv(9, 30), 'planned')]);
  assert.deepEqual(activeSlots([old, live]).map((s) => s.scheduledAt), [kyiv(9, 30)]);
  assert.deepEqual(activeSlots([old]), []);
  assert.deepEqual(activeSlots(null), []);
  assert.deepEqual(activeSlots(undefined), []);
});

test('telegramSlots / otherPlatformCount: a slot with a resourceRef is a copy for another platform', () => {
  const p = plan([slot(kyiv(9, 0)), slot(kyiv(10, 0), 'planned', { resourceRef: 'instagram:abc' }), slot(kyiv(11, 0), 'planned', { resourceRef: null })]);
  assert.equal(telegramSlots([p]).length, 2);
  assert.equal(otherPlatformCount([p]), 1);
  assert.equal(otherPlatformCount([plan([], 'superseded')]), 0);
});

test('buildLanes: 0 slots gives an empty lane for a live channel, none for an off channel, none without channels', () => {
  const lanes = buildLanes({ plans: [], channels: [{ channelKey: '@a', mode: 'live' }, { channelKey: '@b', mode: 'off' }, { channelKey: '@c', mode: 'shadow' }], day: DAY });
  assert.deepEqual(lanes.map((l) => [l.channelKey, l.markers.length, l.rows]), [['@a', 0, 1], ['@c', 0, 1]]);
  assert.deepEqual(buildLanes({ plans: null, channels: null, day: DAY }), []);
  assert.deepEqual(buildLanes({ plans: undefined, channels: [], day: DAY }), []);
});

test('buildLanes: an off channel with slots on the plan keeps its lane; a plan for an unknown channel gets one at the end', () => {
  const lanes = buildLanes({
    plans: [plan([slot(kyiv(9, 0), 'planned', { channelKey: '@b' })], 'active', '@b'), plan([slot(kyiv(10, 0), 'planned', { channelKey: '@z' })], 'active', '@z')],
    channels: [{ channelKey: '@a', mode: 'live' }, { channelKey: '@b', mode: 'off' }],
    day: DAY,
  });
  assert.deepEqual(lanes.map((l) => [l.channelKey, l.markers.length]), [['@a', 0], ['@b', 1], ['@z', 1]]);
});

test('buildLanes: a superseded plan draws nothing, and the other platforms stay off the Telegram lane', () => {
  const lanes = buildLanes({
    plans: [
      plan([slot(kyiv(9, 0), 'skipped', { error: 'superseded by a new plan' })], 'superseded'),
      plan([slot(kyiv(12, 0), 'planned'), slot(kyiv(12, 5), 'planned', { resourceRef: 'threads:x' })]),
    ],
    channels: [{ channelKey: '@ai_global', mode: 'live' }],
    day: DAY,
  });
  assert.equal(lanes.length, 1);
  assert.deepEqual(lanes[0].markers.map((m) => m.time), ['12:00']);
});

test('laneMarkers: markers closer than the marker width stack, far ones share a row; the result is sorted by time', () => {
  const slots = [slot(kyiv(15, 0)), slot(kyiv(9, 0)), slot(kyiv(9, 10)), slot(kyiv(9, MARKER_SPAN_MIN))];
  const { markers, rows } = laneMarkers(slots, DAY);
  assert.deepEqual(markers.map((m) => m.time), ['09:00', '09:10', '09:36', '15:00']);
  // 09:00 row 0, 09:10 overlaps it (row 1), 09:36 is clear of 09:00 (row 0 again), 15:00 row 0.
  assert.deepEqual(markers.map((m) => m.row), [0, 1, 0, 0]);
  assert.equal(rows, 2);
});

test('laneMarkers: two slots at the very same minute never share a row, and the tiebreak is the slot id', () => {
  const a = slot(kyiv(10, 0), 'planned', { id: 'b' });
  const b = slot(kyiv(10, 0), 'published', { id: 'a' });
  const { markers, rows } = laneMarkers([a, b], DAY);
  assert.deepEqual(markers.map((m) => [m.id, m.row]), [['a', 0], ['b', 1]]);
  assert.equal(rows, 2);
});

test('laneMarkers: 16 slots with overlaps get sub-rows, keep every slot, and the lane height grows 20px per row', () => {
  const slots: DaySlot[] = [];
  // Eight posts every 10 minutes from 09:00 (a burst) and eight every two hours: the burst needs several rows.
  for (let i = 0; i < 8; i++) slots.push(slot(kyiv(9, i * 10), i % 2 ? 'published' : 'planned'));
  for (let i = 0; i < 8; i++) slots.push(slot(kyiv(12 + i * 2, 0), 'planned'));
  const { markers, rows } = laneMarkers(slots, DAY);
  assert.equal(markers.length, 16);
  assert.equal(new Set(markers.map((m) => m.id)).size, 16);
  // 36-minute markers 10 minutes apart: four posts fall inside one marker width (09:00-09:30), so the burst needs 4 rows.
  assert.equal(rows, 4);
  assert.ok(markers.every((m) => m.row >= 0 && m.row < rows));
  // No two markers on the same row sit closer than the marker width.
  for (let row = 0; row < rows; row++) {
    const mins = markers.filter((m) => m.row === row).map((m) => m.minutes);
    for (let i = 1; i < mins.length; i++) assert.ok(mins[i] - mins[i - 1] >= MARKER_SPAN_MIN);
  }
  assert.equal(laneHeight(1), 44);
  assert.equal(laneHeight(3), 84);
  assert.equal(laneHeight(0), 44);
});

test('laneMarkers: a slot outside 06:00-24:00 sits on the edge and says so; an owner-time label is built from the status and the reason', () => {
  const { markers } = laneMarkers([
    slot(kyiv(4, 30), 'published'),
    slot(kyiv(0, 30, 1), 'planned'),
    slot(kyiv(12, 0), 'skipped', { error: 'critic_rejected: too long' }),
    slot(kyiv(13, 0), 'skipped', { error: 'skipped by owner' }),
  ], DAY);
  assert.deepEqual(markers.map((m) => [m.time, m.pct, m.clamped]), [['04:30', 0, true], ['12:00', 33.33, false], ['13:00', 38.89, false], ['00:30', 100, true]]);
  assert.equal(markers[0].label, '04:30 · Published · A topic · outside the 06-24 axis');
  assert.equal(markers[1].label, '12:00 · Skipped · A topic · Rejected by the critic');
  assert.equal(markers[2].label, '13:00 · Skipped · A topic · Skipped by you');
});

test('laneMarkers: a series slot that did not go out is Missed; a replan skip and an owner rejection are not', () => {
  const { markers } = laneMarkers([
    slot(kyiv(9, 0), 'skipped', { seriesName: 'Daily fact', error: 'no_fresh_item' }),
    slot(kyiv(11, 0), 'skipped', { seriesName: 'Daily fact', error: 'superseded by a new plan' }),
    slot(kyiv(13, 0), 'skipped', { seriesName: 'Daily fact', error: 'rejected by owner' }),
    slot(kyiv(15, 0), 'skipped', { error: 'no_fresh_item' }),
    slot(kyiv(17, 0), 'planned', { kind: 'reserved', topic: 'Anniversary' }),
  ], DAY);
  assert.deepEqual(markers.map((m) => m.mark), ['missed', 'skipped', 'skipped', 'skipped', 'planned']);
  assert.equal(markers[0].label, '09:00 · Missed · Daily fact · Nothing fresh in the sources');
  assert.equal(markers[4].label, '17:00 · Planned · Reserved: Anniversary');
});

test('legendMarks: only the marks on the timeline, in legend order', () => {
  const lanes = buildLanes({
    plans: [plan([slot(kyiv(9, 0), 'published'), slot(kyiv(10, 0), 'planned'), slot(kyiv(11, 0), 'published'), slot(kyiv(12, 0), 'failed')])],
    channels: [{ channelKey: '@ai_global', mode: 'live' }],
    day: DAY,
  });
  assert.deepEqual(legendMarks(lanes), ['planned', 'published', 'failed']);
  assert.deepEqual(legendMarks([]), []);
});

test('nowLine: inside the axis it has a position and a label; before 06:00, after 24:00 or on another day it is hidden', () => {
  const noon = nowLine(new Date(kyiv(12, 0)), DAY);
  assert.deepEqual(noon, { pct: 33.33, minutes: 720, label: 'now 12:00' });
  assert.equal(nowLine(new Date(kyiv(6, 0)), DAY)?.pct, 0);
  assert.equal(nowLine(new Date(kyiv(23, 59)), DAY)?.pct, 99.91);
  assert.equal(nowLine(new Date(kyiv(5, 59)), DAY), null);
  assert.equal(nowLine(new Date(kyiv(0, 30, 1)), DAY), null);
  assert.equal(nowLine(new Date(kyiv(12, 0)), '2026-10-27'), null);
  assert.equal(nowLine(new Date(kyiv(12, 0)), '2026-10-29'), null);
});

test('pastPct: nothing before 06:00, the share of the axis during the day, everything once the day is over', () => {
  assert.equal(pastPct(new Date(kyiv(5, 0)), DAY), 0);
  assert.equal(pastPct(new Date(kyiv(15, 0)), DAY), 50);
  assert.equal(pastPct(new Date(kyiv(0, 10, 1)), DAY), 100);
  // A plan day that has not started yet: nothing is past.
  assert.equal(pastPct(new Date(kyiv(15, 0)), '2026-10-29'), 0);
});

test('axisMinutes: wall-clock minutes on the two DST days, so markers and the now-line sit under their hour ticks', () => {
  // 2026-10-25 (autumn, UTC+3 → UTC+2): 12:30 Kyiv is 10:30Z, 23:30 Kyiv is 21:30Z.
  assert.equal(axisMinutes('2026-10-25T10:30:00Z', '2026-10-25'), 750);
  assert.equal(axisMinutes('2026-10-25T21:30:00Z', '2026-10-25'), 1410);
  assert.equal(laneMarkers([{ id: 'a', status: 'planned', scheduledAt: '2026-10-25T21:30:00Z' } as DaySlot], '2026-10-25').markers[0].clamped, false);
  assert.deepEqual(nowLine(new Date('2026-10-25T19:00:00Z'), '2026-10-25'), { pct: 83.33, minutes: 1260, label: 'now 21:00' });
  // 2027-03-28 (spring, UTC+2 → UTC+3): 06:30 Kyiv is 03:30Z and sits on the axis; 12:30 is under the 12:00-13:00 ticks.
  assert.equal(axisMinutes('2027-03-28T03:30:00Z', '2027-03-28'), 390);
  assert.equal(axisPct(axisMinutes('2027-03-28T09:30:00Z', '2027-03-28')), 36.11);
  // The next day counts past 24:00, the day before is negative.
  assert.equal(axisMinutes('2026-10-28T22:30:00Z', '2026-10-28'), 1470);
  assert.equal(axisMinutes('2026-10-27T21:30:00Z', '2026-10-28'), -30);
});

test('bucketOf / summarizeDay: done is published + shadowed; a replan skip never counts; missed is its own bucket', () => {
  assert.equal(bucketOf({ status: 'planned' }), 'ahead');
  assert.equal(bucketOf({ status: 'running' }), 'ahead');
  assert.equal(bucketOf({ status: 'awaiting_approval' }), 'ahead');
  assert.equal(bucketOf({ status: 'approved' }), 'ahead');
  assert.equal(bucketOf({ status: 'expired' }), 'skipped');
  assert.equal(bucketOf({ status: 'failed' }), 'failed');
  assert.equal(bucketOf({ status: 'failed', seriesName: 'Daily fact', error: 'boom' }), 'missed');

  const s = summarizeDay([
    { status: 'published' }, { status: 'published' }, { status: 'shadowed' },
    { status: 'skipped', error: 'critic_rejected' },
    { status: 'skipped', error: 'superseded by a new plan' },
    { status: 'skipped', error: 'mode_changed' },
    { status: 'skipped', seriesName: 'Daily fact', error: 'no_fresh_item' },
    { status: 'failed' },
    { status: 'planned' }, { status: 'awaiting_approval' },
  ]);
  assert.deepEqual(s.counts, { published: 2, shadowed: 1, skipped: 1, missed: 1, failed: 1, ahead: 2 });
  assert.equal(s.total, 8);
  assert.equal(s.done, 3);
  assert.deepEqual(summarizeDay([]), { total: 0, done: 0, counts: { published: 0, shadowed: 0, skipped: 0, missed: 0, failed: 0, ahead: 0 } });
});

test('ringArcs: shares of the circle in order; empty parts draw nothing; no total, no arcs', () => {
  const arcs = ringArcs([{ key: 'done', value: 3 }, { key: 'failed', value: 0 }, { key: 'missed', value: 1 }], 8, 100);
  assert.deepEqual(arcs, [
    { key: 'done', dash: 37.5, gap: 62.5, offset: 0 },
    { key: 'missed', dash: 12.5, gap: 87.5, offset: 37.5 },
  ]);
  assert.deepEqual(ringArcs([{ key: 'done', value: 2 }], 0, 100), []);
  assert.deepEqual(ringArcs([], 4, 100), []);
  // Parts that add up to more than the total do not run past the circle.
  const over = ringArcs([{ key: 'a', value: 3 }, { key: 'b', value: 3 }], 4, 100);
  assert.equal(over.length, 2);
  assert.equal(over[0].dash + over[1].dash, 100);
});

test('busiestChannel: the highest share of its cap; without caps the biggest spender; nothing spent is null', () => {
  const ch = (channelKey: string, spendUsd: number, dailyBudgetUsd: number | null) => ({ channelKey, title: null, dailyBudgetUsd, today: { spendUsd } });
  const a = busiestChannel([ch('@a', 1.2, 3), ch('@b', 0.9, 1), ch('@c', 2, null)]);
  assert.equal(a?.channelKey, '@b');
  assert.equal(a?.capUsd, 1);
  assert.equal(Math.round(a?.pct ?? 0), 90);
  const b = busiestChannel([ch('@a', 0.4, null), ch('@b', 0.9, null)]);
  assert.deepEqual([b?.channelKey, b?.capUsd, b?.pct], ['@b', null, null]);
  assert.equal(busiestChannel([ch('@a', 0, 3), ch('@b', 0, null)]), null);
  assert.equal(busiestChannel([]), null);
  assert.equal(busiestChannel(null), null);
  // A zero cap is no cap.
  assert.equal(busiestChannel([ch('@a', 0.5, 0)])?.pct, null);
});

test('capState: ok under 70 %, warning from 70, danger from 90 and over the cap; no cap is none', () => {
  assert.equal(capState(0), 'ok');
  assert.equal(capState(69.9), 'ok');
  assert.equal(capState(70), 'warning');
  assert.equal(capState(89.9), 'warning');
  assert.equal(capState(90), 'danger');
  assert.equal(capState(140), 'danger');
  assert.equal(capState(null), 'none');
  assert.equal(capState(NaN), 'none');
});

test('orchestratorsByChannel: telegram orchestrators anywhere in the tree, keyed by the channel', () => {
  const tree = [
    { kind: 'manager', scopeId: null, children: [
      { kind: 'orchestrator', scopeId: 'telegram:@ai_global', children: [{ kind: 'writer', scopeId: 'telegram:@ai_global' }] },
      { kind: 'orchestrator', scopeId: 'instagram:abc' },
    ] },
    { kind: 'orchestrator', scopeId: 'telegram:@recipes' },
  ];
  const map = orchestratorsByChannel(tree);
  assert.deepEqual([...map.keys()], ['@ai_global', '@recipes']);
  assert.equal(orchestratorsByChannel(undefined).size, 0);
});

test('systemAgents: the manager, builder and auditor roots; orchestrators and unknown kinds are not system agents', () => {
  const roots = [{ kind: 'manager', n: 1 }, { kind: 'orchestrator', n: 2 }, { kind: 'builder', n: 3 }, { kind: 'auditor', n: 4 }, { kind: 'ideator', n: 5 }];
  assert.deepEqual(systemAgents(roots).map((r) => r.n), [1, 3, 4]);
  assert.deepEqual(systemAgents(undefined), []);
});

test('recentEvents: newest first, at most six by default, the input is not mutated, a bad time sorts last', () => {
  const ev = (id: string, at: string) => ({ id, at });
  const input = [ev('a', '2026-10-29T10:00:00Z'), ev('b', '2026-10-29T12:00:00Z'), ev('c', '2026-10-29T11:00:00Z'), ev('d', 'not a date'), ev('e', '2026-10-29T12:00:00Z')];
  assert.deepEqual(recentEvents(input).map((e) => e.id), ['e', 'b', 'c', 'a', 'd']);
  assert.deepEqual(input.map((e) => e.id), ['a', 'b', 'c', 'd', 'e']);
  const many = Array.from({ length: 10 }, (_, i) => ev(`x${i}`, `2026-10-29T0${i}:00:00Z`));
  assert.equal(recentEvents(many).length, ACTIVITY_ROWS);
  assert.deepEqual(recentEvents(many, 2).map((e) => e.id), ['x9', 'x8']);
  assert.deepEqual(recentEvents(null), []);
  assert.deepEqual(recentEvents(many, -1), []);
});

test('signed / metaFollowersLine: reconnecting comes before the 24 h change', () => {
  assert.equal(signed(163), '+163');
  assert.equal(signed(-40), '−40');
  assert.equal(signed(0), '0');
  assert.equal(signed(12345), '+12,345');
  assert.deepEqual(metaFollowersLine(1, 163), { text: '1 account needs reconnecting', tone: 'warning' });
  assert.deepEqual(metaFollowersLine(3, 0), { text: '3 accounts need reconnecting', tone: 'warning' });
  assert.deepEqual(metaFollowersLine(0, 163), { text: '+163 in 24 h', tone: 'success' });
  assert.deepEqual(metaFollowersLine(0, -5), { text: '−5 in 24 h', tone: 'danger' });
  assert.deepEqual(metaFollowersLine(0, 0), { text: 'no change in 24 h', tone: 'neutral' });
});

test('healthLabel: all clear, one problem, many', () => {
  assert.equal(healthLabel(0), 'all clear');
  assert.equal(healthLabel(-1), 'all clear');
  assert.equal(healthLabel(1), '1 problem');
  assert.equal(healthLabel(2), '2 problems');
});

test('reconnectCount: unmuted Meta accounts with a dead token or no access; an expiring token and a Telegram problem do not count', () => {
  const c = (ref: string, state: string, muted = false) => ({ ref, state, muted });
  assert.equal(reconnectCount([
    c('threads:1', 'token_invalid'), c('instagram:2', 'no_access'), c('facebook:3', 'token_invalid', true),
    c('instagram:4', 'token_expiring'), c('telegram:@x', 'no_access'), c('threads:5', 'rate_limited'),
  ]), 2);
  assert.equal(reconnectCount(null), 0);
});
