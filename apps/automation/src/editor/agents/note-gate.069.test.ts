// Spec 069 FR-004 on fakes: the gate compares with everything the subject said in the window (the union), a number is
// news only when it grew by a whole step, and the run length says how long a problem has been re-announced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GROW_STEP, DEMOTE_AFTER, decideNote, noteGrowStep, noteRun, type PastNote } from './note-gate';

const DAY = 86_400_000;
const NOW = new Date('2026-10-22T15:00:00Z');
const past = (daysAgo: number, parts: string[] | null): PastNote => ({ parts, createdAt: new Date(NOW.getTime() - daysAgo * DAY) });
const fires = (p: PastNote[], parts: string[], o = {}) => decideNote(p, parts, NOW, 3, o).fire;

test('a number fires only when it grew by a whole step over the largest one said in the window', () => {
  assert.equal(fires([past(1, ['streak:8'])], ['streak:6']), false, '8 → 6 is a decrease');
  assert.equal(fires([past(1, ['streak:8'])], ['streak:9']), false, '8 → 9 is one more, the step is 3');
  assert.equal(fires([past(1, ['streak:8'])], ['streak:10']), false);
  assert.equal(fires([past(1, ['streak:8'])], ['streak:11']), true, '8 → 11');
  assert.equal(fires([past(1, ['streak:8'])], ['streak:11'], { step: 5 }), false, 'a bigger default step');
  assert.equal(fires([past(1, ['streak:8'])], ['streak:11'], { step: 5, grow: { streak: 3 } }), true, 'the gate\'s own step wins');
  assert.equal(fires([past(1, ['days:3'])], ['days:4'], { grow: { days: 3 } }), false);
  assert.equal(fires([past(1, ['days:3'])], ['days:6'], { grow: { days: 3 } }), true);
  assert.equal(fires([past(1, ['days:3'])], ['streak:3']), true, 'another name is another part: new');
});

test('the window is the union of its notes: 8 → 6 → 8 and A → B → A do not fire', () => {
  // Newest first: the owner has seen streak 8 and streak 6 (from a restart) in the last days.
  assert.equal(fires([past(0.5, ['streak:6']), past(1.5, ['streak:8'])], ['streak:8']), false, '8 → 6 → 8');
  assert.equal(fires([past(0.5, ['missed:Prompt:critic']), past(1, ['missed:Prompt:lint'])], ['missed:Prompt:critic']), false, 'A → B → A');
  assert.equal(fires([past(0.5, ['missed:Prompt:lint']), past(1, ['missed:Prompt:critic'])], ['missed:Prompt:critic', 'missed:Prompt:lint']), false, 'both were said');
  assert.equal(fires([past(0.5, ['missed:Prompt:lint']), past(1, ['missed:Prompt:critic'])], ['missed:Prompt:budget']), true, 'a cause nobody said');
  // A note older than the window is forgotten: the cause comes back as news.
  assert.deepEqual(decideNote([past(0.5, ['b']), past(4, ['a'])], ['a'], NOW, 3).fire, true);
});

test('a numeric part that was said before the window and comes back smaller is "still going", not news', () => {
  const d = decideNote([past(5, ['streak:8'])], ['streak:3'], NOW, 3);
  assert.equal(d.fire, true);
  assert.equal(d.fire && d.why, 'repeat', 'everything it says was said (8 ≥ 3): the problem is still going');
  const grown = decideNote([past(5, ['streak:8'])], ['streak:11'], NOW, 3);
  assert.equal(grown.fire && grown.why, 'changed');
});

test('the repeat after the window and the quiet inside it are unchanged', () => {
  assert.deepEqual(decideNote([past(3, ['x'])], ['x'], NOW, 3).fire, true);
  assert.deepEqual(decideNote([past(2.9, ['x'])], ['x'], NOW, 3).fire, false);
  assert.equal(decideNote([], ['x'], NOW, 3).fire && (decideNote([], ['x'], NOW, 3) as { why: string }).why, 'first');
});

test('runLength counts the notes of the unbroken run, this one included; a gap over repeatDays + 1 days ends it', () => {
  assert.equal(decideNote([], ['x'], NOW, 3).runLength, 1);
  assert.equal(decideNote([], ['x'], NOW, 3).runSince, null);
  // Notes 3 days apart (the repeat rhythm): 1 + 3 earlier = 4, since the oldest.
  const run = decideNote([past(3, ['x']), past(6, ['x']), past(9, ['x'])], ['x'], NOW, 3);
  assert.equal(run.runLength, 4);
  assert.equal(run.runSince?.getTime(), past(9, []).createdAt.getTime());
  // A gap of 5 days (> 3 + 1) between the third and the fourth note ends the run.
  const broken = decideNote([past(1, ['x']), past(2, ['x']), past(7, ['x'])], ['x'], NOW, 3);
  assert.equal(broken.runLength, 3);
  // The last note itself too old to continue: the run starts again.
  assert.equal(decideNote([past(6, ['x']), past(7, ['x'])], ['y'], NOW, 3).runLength, 1);
  assert.equal(decideNote([past(4, ['x'])], ['y'], NOW, 3).runLength, 2, '4 days = repeatDays + 1: still the same run');
  assert.equal(DEMOTE_AFTER, 3);
});

test('noteRun counts back from now; noteGrowStep reads the critic streak setting', () => {
  assert.deepEqual(noteRun([], NOW, 3), { count: 0, since: null });
  assert.equal(noteRun([past(1, null).createdAt, past(2, null).createdAt], NOW, 3).count, 2);
  assert.equal(noteRun([past(5, null).createdAt], NOW, 3).count, 0, 'the newest note is already too old for the run');
  const env = (v: string | undefined) => (k: string) => (k === 'EDITOR_CRITIC_REJECT_STREAK' ? v : undefined);
  assert.deepEqual([undefined, '', '0', 'x', '5', '2.9'].map((v) => noteGrowStep(env(v))), [DEFAULT_GROW_STEP, 3, 3, 3, 5, 2]);
});
