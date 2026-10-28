// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 D2: the one status map, and the "missed" rule whose prefix lists mirror the backend's skip reasons.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MARK_LABEL, MARK_ORDER, NOT_A_MISS, OWNER_DECISION, PUBLICATION_TONE, SLOT_TONE,
  isMissed, isNotAMiss, isOwnerDecision, markTone, publicationLabel, publicationTone, slotLabel, slotMark, slotTone,
} from './status-tone';

test('every slot status has a tone and a label; the handoff table is the source', () => {
  assert.deepEqual(SLOT_TONE, {
    planned: 'neutral', running: 'accent', awaiting_approval: 'warning', approved: 'accent', shadowed: 'neutral',
    published: 'success', skipped: 'neutral', failed: 'danger', expired: 'warning',
  });
  for (const s of Object.keys(SLOT_TONE)) assert.ok(MARK_LABEL[s as keyof typeof MARK_LABEL], `label for ${s}`);
  assert.equal(new Set(MARK_ORDER).size, MARK_ORDER.length, 'no mark listed twice');
  assert.equal(MARK_ORDER.length, Object.keys(MARK_LABEL).length, 'the legend order lists every mark');
});

test('slotTone: null is "not planned" (warning), an unknown status is neutral', () => {
  assert.equal(slotTone(null), 'warning');
  assert.equal(slotTone(undefined), 'warning');
  assert.equal(slotTone('published'), 'success');
  assert.equal(slotTone('skipped'), 'neutral');
  assert.equal(slotTone('something_new'), 'neutral');
  assert.equal(markTone('missed'), 'warning');
  assert.equal(markTone('not_planned'), 'warning');
  assert.equal(markTone('yours'), 'neutral');
  assert.equal(markTone('awaiting_approval'), 'warning');
});

test('slotLabel: sentence case, null is "Not planned", unknown statuses keep the API text', () => {
  assert.equal(slotLabel('awaiting_approval'), 'Awaiting approval');
  assert.equal(slotLabel(null), 'Not planned');
  assert.equal(slotLabel('half_done'), 'half done');
});

test('publication tones: one map for scheduled_publications', () => {
  assert.deepEqual(PUBLICATION_TONE, { pending: 'neutral', sending: 'accent', sent: 'success', failed: 'danger', canceled: 'neutral', unknown: 'warning' });
  assert.equal(publicationTone('sent'), 'success');
  assert.equal(publicationTone('???'), 'neutral');
  assert.equal(publicationLabel('pending'), 'Scheduled');
  assert.equal(publicationLabel('weird'), 'weird');
});

test('isMissed: a series or pin slot that did not go out', () => {
  assert.equal(isMissed({ status: 'skipped', seriesName: 'Daily fact', error: 'no_fresh_item: nothing new' }), true);
  assert.equal(isMissed({ status: 'failed', scheduleRuleId: 'rule-1', error: 'lint_failed' }), true);
  assert.equal(isMissed({ status: 'expired', seriesName: 'Daily fact', error: null }), true);
  assert.equal(isMissed({ status: 'skipped', seriesName: 'Daily fact' }), true, 'error may be absent');
});

test('isMissed: only series and pins can miss (the handoff pseudo-code lost its parentheses)', () => {
  // `a || b && c` would call this a miss: the series test must wrap the whole rule.
  assert.equal(isMissed({ status: 'published', seriesName: 'Daily fact', error: null }), false);
  assert.equal(isMissed({ status: 'planned', scheduleRuleId: 'rule-1', error: null }), false);
  assert.equal(isMissed({ status: 'skipped', seriesName: null, scheduleRuleId: null, error: 'no_fresh_item' }), false, 'a plain slot is just skipped');
  assert.equal(isMissed({ status: 'failed', error: 'budget_exceeded' }), false);
  assert.equal(isMissed({ status: null, seriesName: 'Daily fact' }), false, 'not planned is its own state');
});

test('isMissed: bookkeeping and the owner\'s decisions are not misses', () => {
  for (const error of [
    'superseded by a new plan', 'mode_changed: live → off', 'draft canceled by owner', 'series_paused: Daily fact', 'series_paused',
    'rejected by owner', 'resource_paused: instagram:ig1', 'agent @space is paused', 'agent paused',
  ]) {
    assert.equal(isMissed({ status: 'skipped', seriesName: 'Daily fact', error }), false, error);
  }
  assert.equal(isMissed({ status: 'skipped', seriesName: 'Daily fact', error: '  superseded by a new plan  ' }), false, 'the error is trimmed');
  assert.equal(isMissed({ status: 'skipped', scheduleRuleId: 'r', error: 'series_paused' }), false);
});

test('prefixes anchor at the start and keep word boundaries', () => {
  assert.equal(isNotAMiss('the plan was superseded by a new plan'), false, 'a prefix, not a substring');
  assert.equal(isNotAMiss('series_paused_later'), false, '\\b after series_paused');
  assert.equal(isNotAMiss('series_paused'), true);
  assert.equal(isOwnerDecision('agent @a_b is paused until Monday'), true);
  assert.equal(isOwnerDecision('rejected by the owner'), false, 'the exact backend wording');
  assert.equal(isOwnerDecision(null), false);
});

test('slotMark: missed wins over the stored status, null status is "not planned", unknown is planned', () => {
  assert.equal(slotMark({ status: 'skipped', seriesName: 'S', error: 'lint_failed' }), 'missed');
  assert.equal(slotMark({ status: 'skipped', seriesName: 'S', error: 'rejected by owner' }), 'skipped');
  assert.equal(slotMark({ status: 'published', seriesName: 'S' }), 'published');
  assert.equal(slotMark({ status: null }), 'not_planned');
  assert.equal(slotMark({ status: 'brand_new_status' }), 'planned');
});

// ── the backend's lists, read from source ───────────────────────────────────

const BACKEND = fileURLToPath(new URL('../../../automation/src/editor/silent/skip-reasons.ts', import.meta.url));

/** The regex array literal assigned to `const <name> = [...]` in the backend file. */
function backendList(src: string, name: string): RegExp[] {
  const m = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`).exec(src);
  assert.ok(m, `${name} not found in skip-reasons.ts: did it move?`);
  return new Function(`return ${m[1]}`)() as RegExp[];
}

const same = (a: readonly RegExp[], b: readonly RegExp[]) => assert.deepEqual(a.map(String), b.map(String));

test('NOT_A_MISS and OWNER_DECISION are the backend\'s NOT_A_MISS and OWNER (skip-reasons.ts)', { skip: !existsSync(BACKEND) && 'backend source not in this checkout' }, () => {
  const src = readFileSync(BACKEND, 'utf8');
  same(NOT_A_MISS, backendList(src, 'NOT_A_MISS'));
  same(OWNER_DECISION, backendList(src, 'OWNER'));
});
