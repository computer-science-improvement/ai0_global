import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEERING_RULE_KINDS } from '../api/steering';
import { isBusy, RULE_KIND_LABEL, refLabel, rulesEditable, rulesLine, STEERING_STATUS, steeringActions, steeringErrorText } from './steering';

test('steering: every status and rule kind has a label', () => {
  for (const s of ['queued', 'collecting', 'analyzing', 'ready', 'active', 'paused', 'discarded', 'superseded', 'failed', 'no_access', 'too_few_posts'] as const) {
    assert.ok(STEERING_STATUS[s].label, s);
  }
  for (const k of STEERING_RULE_KINDS) assert.ok(RULE_KIND_LABEL[k], k);
});

test('steering: actions follow the lifecycle; rules are editable while ready, active or paused', () => {
  assert.deepEqual(steeringActions('ready'), ['activate', 'discard']);
  assert.deepEqual(steeringActions('active'), ['pause', 'reanalyze', 'discard']);
  assert.deepEqual(steeringActions('paused'), ['resume', 'reanalyze', 'discard']);
  assert.deepEqual(steeringActions('analyzing'), []);
  assert.deepEqual(steeringActions('superseded'), ['reanalyze']);
  assert.ok(rulesEditable('active') && !rulesEditable('discarded'));
  assert.ok(isBusy('collecting') && !isBusy('ready'));
});

test('steering: the count line and labels', () => {
  assert.equal(rulesLine({ rulesActive: 4, rulesTotal: 6, conflicts: 1, status: 'ready' }), '4 of 6 rules on · 1 conflict');
  assert.equal(rulesLine({ rulesActive: 1, rulesTotal: 1, conflicts: 0, status: 'active' }), '1 of 1 rule on');
  assert.equal(rulesLine({ rulesActive: 0, rulesTotal: 0, conflicts: 0, status: 'queued' }), null);
  assert.equal(refLabel('telegram:@ref'), '@ref');
  assert.match(steeringErrorText('too_many_active', 'x'), /at most 3/);
  assert.equal(steeringErrorText('weird', 'fallback'), 'fallback');
});
