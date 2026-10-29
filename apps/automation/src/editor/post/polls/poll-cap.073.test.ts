/**
 * Spec 073 FR-001: the poll cap never blocks or counts a series instance or a pin. The mark is on the slot, so the guard
 * needs no playbook lookup; an improvised poll is still capped. Covers the publish guard, the timeline check (export
 * audit, golden set, post audit) and the plan-time validator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollCapGuard, pollCapIssue, type PollCapGuardInput, type PollCapRow } from './poll-cap-guard';
import { pollCapCheck } from '../integrity/checks/polls';
import { auditPostFromSpec } from '../integrity/from-post-spec';
import { makeSpec } from '../testing/fixtures';
import { pollCapErrors, pollCapExempt } from '../../roles/poll-cap';

const TZ = 'Europe/Kyiv';
const DAY = 86_400_000;
const MON = new Date('2026-10-05T09:00:00Z');
const base = (o: Partial<PollCapGuardInput> = {}): PollCapGuardInput => ({ channelKey: '@chan', format: 'quiz', at: MON, timezone: TZ, cap: 1, ...o });
const row = (dayOffset: number, extra: Partial<PollCapRow> = {}): PollCapRow => ({ at: new Date(MON.getTime() + dayOffset * DAY), series: null, ...extra });

test('a daily quiz series on a resource with polls_per_week 1 passes the guard on every day of the week', () => {
  // Each day the guard sees the quizzes of the other days of the series, all marked with the series.
  const week = [0, 1, 2, 3, 4, 5, 6].map((d) => row(d, { series: 'Білети ПДР' }));
  for (let d = 0; d < 7; d++) {
    const others = week.filter((_, i) => i !== d);
    const at = new Date(MON.getTime() + d * DAY);
    assert.equal(pollCapIssue(base({ at, series: 'Білети ПДР' }), others), null, `day ${d}`);
  }
});

test('an improvised second poll is still refused, with or without series rows beside it', () => {
  const rows = [row(-1), row(0, { series: 'Білети ПДР' })];
  assert.equal(pollCapIssue(base({ format: 'poll' }), rows)?.error, 'poll_cap_reached');
  // The series rows do not count: with only series rows around, the one improvised poll fits the cap.
  assert.equal(pollCapIssue(base({ format: 'poll' }), [row(0, { series: 'Білети ПДР' }), row(1, { series: 'Білети ПДР' })]), null);
});

test('a pin is exempt both ways: it is never blocked and the rows that are pins do not count', () => {
  assert.equal(pollCapIssue(base({ pin: true }), [row(-1), row(1)]), null, 'a pin is never blocked');
  assert.equal(pollCapIssue(base(), [row(-1, { pin: true }), row(1, { pin: true })]), null, 'pins do not fill the cap');
  assert.equal(pollCapIssue(base(), [row(-1, { pin: true }), row(1)])?.error, 'poll_cap_reached', 'an improvised row beside the new improvised post fills the cap of 1');
  assert.equal(pollCapIssue(base(), [row(-1, { pin: true }), row(20)]), null, 'an improvised row outside the 7 days does not');
  assert.equal(pollCapExempt({ series: 'x' }), true);
  assert.equal(pollCapExempt({ pin: true }), true);
  assert.equal(pollCapExempt({ series: null, pin: false }), false);
});

test('pollCapGuard: a series or pin slot never reaches the database', async () => {
  const calls: unknown[] = [];
  const pool = { query: async (...a: unknown[]) => { calls.push(a); return { rows: [row(0), row(1)].map((r) => ({ at: r.at, series: null, pin: false })) }; } } as any;
  assert.equal(await pollCapGuard(pool, base({ series: 'Білети ПДР' })), null);
  assert.equal(await pollCapGuard(pool, base({ pin: true })), null);
  assert.equal(calls.length, 0);
  assert.equal((await pollCapGuard(pool, base()))?.error, 'poll_cap_reached');
  assert.equal(calls.length, 1);
});

test('pollCapGuard: the loaded rows carry the series and the pin marks the SQL selects', async () => {
  const pool = { query: async () => ({ rows: [
    { at: new Date(MON.getTime() - DAY), series: 'Білети ПДР', pin: false },
    { at: new Date(MON.getTime() + DAY), series: null, pin: true },
  ] }) } as any;
  assert.equal(await pollCapGuard(pool, base({ format: 'poll' })), null, 'a series row and a pin row do not count');
});

// ── the timeline check (export audit, golden set, post audit) ────────────────────────────────

const spec = () => makeSpec({ format: 'quiz', title: 'Вікторина', origin: 'original', media: [], hashtags: [], source: undefined, body: [], poll: { question: 'Яка планета найбільша?', options: ['Сатурн', 'Юпітер', 'Нептун'], anonymous: true, correct_index: 1 } });
const auditPost = (id: string, day: number, exempt = false) => {
  const p = auditPostFromSpec(spec(), { id, channel: '@chan', publishedAt: new Date(MON.getTime() + day * DAY).toISOString(), timezone: TZ });
  if (exempt) p.pollCapExempt = true;
  return p;
};

test('pollCapCheck: an exempt post is not checked, and exempt earlier posts do not count', () => {
  const first = auditPost('a', 0);
  const second = auditPost('b', 2);
  assert.deepEqual(pollCapCheck.run(second, { previous: [first] }).map((f) => f.code), ['poll_cap_reached'], 'two improvised polls in a week');
  assert.deepEqual(pollCapCheck.run(auditPost('b', 2, true), { previous: [first] }), [], 'a series instance is never flagged');
  assert.deepEqual(pollCapCheck.run(second, { previous: [auditPost('a', 0, true)] }), [], 'earlier series posts do not fill the cap');
  assert.deepEqual(pollCapCheck.run(second, { previous: [auditPost('a', 0, true), auditPost('c', 1, true)] }), []);
  // An export post has no slot, so nothing marks it: unchanged.
  assert.equal(auditPost('x', 0).pollCapExempt, undefined);
});

// ── the plan-time validator ──────────────────────────────────────────────────────────────────

test('pollCapErrors: the slot\'s own series mark exempts it, whoever made the series', () => {
  const ctx = { caps: { 'telegram:@chan': 1 }, recent: [{ resourceRef: 'telegram:@chan', series: null }], defaultRef: 'telegram:@chan' };
  const series = [{ format: 'quiz', series: 'Білети ПДР' }, { format: 'quiz', sourceHints: ['series:Білети ПДР'] }];
  assert.deepEqual(pollCapErrors(series, ctx), [], 'series slots do not count against the one improvised poll already out');
  assert.equal(pollCapErrors([{ format: 'poll' }], ctx).length, 1, 'an improvised poll does');
  assert.equal(pollCapErrors([...series, { format: 'poll' }], ctx).length, 1);
});
