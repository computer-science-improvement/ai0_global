// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B1: the pure logic of Today (/app).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEEDS_ROWS, greetingFor, inboxLinkCount, kyivEyebrow, kyivGreeting, needsHeadline, needsSummary, openNotes, shorten, sortNotes,
  type NoteLike,
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
