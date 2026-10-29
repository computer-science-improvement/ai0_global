// Spec 073 T7 (FR-007, A24): a series that stopped for two local days in a row — every slot closed for a non-material, non-owner
// reason and none out — adds the part `stalled:<name>` (and one line in the body and the alert) to the day's series_missed note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSilentDays, stalledSeries, type WatchSlot } from './silent-days';

const TZ = 'Europe/Kyiv';                       // UTC+3 in October
const REF = 'telegram:@prompts';
const NOW = new Date('2026-10-12T10:00:00Z');   // 13:00 local on the 12th
const TODAY = '2026-10-12';
const RES = [{ ref: REF, tz: TZ, minPerDay: 0 }];

let n = 0;
function slot(o: Partial<WatchSlot> & { at: string }): WatchSlot {
  const { at, ...rest } = o;
  return {
    id: `s${++n}`, ref: REF, scheduledAt: new Date(at), updatedAt: new Date(at), status: 'skipped', error: null, format: 'text', topic: 'Тема',
    seriesName: 'Prompt', scheduleRuleId: null, criticVerdict: null, fallback: null, ...rest,
  };
}
const YEST = '2026-10-11T07:00:00Z';            // 10:00 local on the 11th
const TOD = '2026-10-12T07:00:00Z';             // 10:00 local on the 12th
const SKIPPED = 'planner_skipped: Пораду пропущено, бо тиждень без неї';

const noteOf = (slots: WatchSlot[]) => evaluateSilentDays({ now: NOW, resources: RES, slots }).find((a) => a.kind === 'series_missed' && a.day === TODAY);
const stalledParts = (slots: WatchSlot[]) => (noteOf(slots)?.parts ?? []).filter((p) => p.startsWith('stalled:'));

test('one day: today\'s miss is a series_missed note without the stalled part', () => {
  const note = noteOf([slot({ at: TOD, error: SKIPPED })]);
  assert.ok(note);
  assert.deepEqual(note!.parts.filter((p) => p.startsWith('stalled:')), []);
  assert.doesNotMatch(note!.body, /two days in a row/);
});

test('two days: one stalled:<name> part, one line in the body and in the alert (the code until the catalogue)', () => {
  const note = noteOf([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: SKIPPED })])!;
  assert.deepEqual(note.parts.filter((p) => p.startsWith('stalled:')), ['stalled:Prompt']);
  assert.match(note.body, /Series "Prompt" has not gone out two days in a row: planner_skipped/);
  assert.match(note.alert.body, /Серія «Prompt» не виходить два дні поспіль: planner_skipped/);
  assert.equal(note.day, TODAY);
  assert.equal(note.subject, `silent:${REF}:miss`, 'the day\'s miss subject: it merges with the dark_day note');
  assert.equal(note.parts.filter((p) => p === 'stalled:Prompt').length, 1);
});

test('the qualifying reasons: planner_skipped, lint and other, in any mix across the two days', () => {
  assert.deepEqual(stalledParts([slot({ at: YEST, error: 'lint_failed: caption_too_long' }), slot({ at: TOD, error: SKIPPED })]), ['stalled:Prompt']);
  assert.deepEqual(stalledParts([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, status: 'failed', error: 'max_steps: ran out of steps' })]), ['stalled:Prompt']);
  assert.deepEqual(stalledParts([slot({ at: YEST, error: 'skipped by agent: пост не склався' }), slot({ at: TOD, error: 'lint_failed: too_long' })]), ['stalled:Prompt']);
  const note = noteOf([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: 'lint_failed: caption_too_long' })])!;
  assert.match(note.body, /two days in a row: lint_failed/, 'the code of today\'s latest close');
});

test('a material, owner, critic or budget close on either day: none', () => {
  for (const bad of ['planner_no_material: немає матеріалу', 'preflight_source_used: джерело вже було', 'rejected by owner', 'resource_paused: pause', 'critic_rejected: reject (grounding 2): вигадано', 'budget_exceeded: channel cap']) {
    assert.deepEqual(stalledParts([slot({ at: YEST, error: bad }), slot({ at: TOD, error: SKIPPED })]), [], `yesterday: ${bad}`);
    assert.deepEqual(stalledParts([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: bad })]), [], `today: ${bad}`);
  }
  // The owner's own «mode changed» / «superseded» closes are not counted at all (not a miss), so they cannot make a stall either.
  assert.deepEqual(stalledParts([slot({ at: YEST, error: 'superseded by a new plan' }), slot({ at: TOD, error: SKIPPED })]), []);
});

test('a post out on either day, or a slot not yet closed today: none', () => {
  assert.deepEqual(stalledParts([slot({ at: YEST, status: 'published' }), slot({ at: TOD, error: SKIPPED })]), [], 'out yesterday');
  assert.deepEqual(stalledParts([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, status: 'shadowed' })]), [], 'out today');
  assert.deepEqual(stalledParts([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: SKIPPED }), slot({ at: '2026-10-12T14:00:00Z', status: 'shadowed' })]), [], 'a second instance went out today');
  assert.deepEqual(stalledParts([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: SKIPPED }), slot({ at: '2026-10-12T15:00:00Z', status: 'planned' })]), [], 'one still to come today');
  assert.deepEqual(stalledParts([slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: SKIPPED }), slot({ at: YEST, status: 'published' })]), [], 'one of two out yesterday');
});

test('two days means consecutive local days: the day before yesterday does not count, and a series with no slot yesterday is not stalled', () => {
  assert.deepEqual(stalledParts([slot({ at: '2026-10-10T07:00:00Z', error: SKIPPED }), slot({ at: TOD, error: SKIPPED })]), []);
  assert.deepEqual(stalledParts([slot({ at: TOD, error: SKIPPED })]), []);
  // 20:30Z on the 11th is 23:30 local on the 11th; 21:30Z on the 11th is 00:30 local on the 12th (today): two local days, though one UTC day.
  assert.deepEqual(stalledParts([slot({ at: '2026-10-11T20:30:00Z', error: SKIPPED }), slot({ at: '2026-10-11T21:30:00Z', error: SKIPPED })]), ['stalled:Prompt'], 'the local day decides, not the UTC date');
});

test('only the stalled series gets the part; another series and plain slots of the day are untouched', () => {
  const slots = [
    slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: SKIPPED }),
    slot({ id: 'other-y', at: YEST, seriesName: 'Інша серія', status: 'published' }), slot({ id: 'other-t', at: TOD, seriesName: 'Інша серія', error: 'lint_failed: x' }),
    slot({ id: 'plain', at: TOD, seriesName: null, error: 'lint_failed: x' }),
  ];
  const note = noteOf(slots)!;
  assert.deepEqual(note.parts.filter((p) => p.startsWith('stalled:')), ['stalled:Prompt']);
  assert.deepEqual([...stalledSeries(slots.filter((s) => !s.id.startsWith('plain')), TODAY, TZ).keys()], ['Prompt']);
});

test('a stalled part rides along into the merged dark_day note', () => {
  const evening = new Date('2026-10-12T16:30:00Z');                    // 19:30 local: the dark-day hour has passed
  const alerts = evaluateSilentDays({ now: evening, resources: RES, slots: [slot({ at: YEST, error: SKIPPED }), slot({ at: TOD, error: SKIPPED })] });
  const today = alerts.filter((a) => a.day === TODAY);
  assert.equal(today.length, 1, 'today\'s series_missed merged into the dark_day note');
  assert.equal(today[0].kind, 'dark_day');
  assert.ok(today[0].parts.includes('stalled:Prompt'));
  assert.match(today[0].body, /has not gone out two days in a row/);
});
