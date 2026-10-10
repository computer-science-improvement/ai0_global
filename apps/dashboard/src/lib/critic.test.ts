// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 034 FR-004: how the critic's verdict is shown on approval and draft cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criticFootnote, heldByCritic, scoreList, scoreTone, verdictBadge, type CriticVerdict } from './critic';

const v = (o: Partial<CriticVerdict> = {}): CriticVerdict => ({
  verdict: 'pass', scores: { ai_likeness: 5, sense: 4, voice: 3, grounding: 2, audience_asks: 5, format_fit: 5 }, notes: 'n', reason: 'r',
  pass: 1, slop_warnings: [], model: 'm', run_id: null, cost_usd: 0, at: '2026-10-10T10:00:00Z', ...o,
});

test('verdictBadge: "Critic: pass/revise/reject" with tones; a final revise and an unavailable critic say so', () => {
  assert.deepEqual(verdictBadge(v()), { label: 'Critic: pass', tone: 'success' });
  assert.deepEqual(verdictBadge(v({ verdict: 'revise' })), { label: 'Critic: revise', tone: 'warning' });
  assert.equal(verdictBadge(v({ verdict: 'revise', final: true })).label, 'Critic: revise (after one rewrite)');
  assert.deepEqual(verdictBadge(v({ verdict: 'reject' })), { label: 'Critic: reject', tone: 'danger' });
  assert.deepEqual(verdictBadge(v({ verdict: 'error' })), { label: 'Critic: unavailable', tone: 'neutral' });
});

test('scoreList keeps the backend order and colours by the thresholds (≤ 2 reject, 3 revise)', () => {
  const list = scoreList(v());
  assert.deepEqual(list.map((s) => s.key), ['ai_likeness', 'sense', 'voice', 'grounding', 'audience_asks', 'format_fit']);
  assert.deepEqual(list.map((s) => s.tone), ['success', 'success', 'warning', 'danger', 'success', 'success']);
  assert.equal(list[0].label, 'Human voice');
  assert.deepEqual(scoreList(v({ verdict: 'error', scores: null })), []);
  assert.equal(scoreTone(1), 'danger');
  assert.equal(scoreTone(4), 'success');
});

test('held from "Approve all" unless pass; footnotes per place', () => {
  assert.equal(heldByCritic(undefined), false);
  assert.equal(heldByCritic(v()), false);
  assert.equal(heldByCritic(v({ verdict: 'revise', final: true })), true);
  assert.equal(heldByCritic(v({ verdict: 'error' })), true);
  assert.match(criticFootnote(v({ verdict: 'revise', final: true }), 'approval')!, /rewrote it once/);
  assert.match(criticFootnote(v({ verdict: 'error' }), 'approval')!, /did not answer/);
  assert.equal(criticFootnote(v(), 'approval'), null);
  assert.equal(criticFootnote(v({ pass: 2 }), 'approval'), 'Passed after one rewrite.');
  assert.match(criticFootnote(v({ verdict: 'reject' }), 'draft')!, /never blocks/);
});
