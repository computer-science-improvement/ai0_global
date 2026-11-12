// Spec 103 §8 row 10: every owner skip prefix (dashboard, chat card, connector cancel_post) is the owner's decision, not a miss,
// so neither the SLO controller nor the series breaker makes it up and no silent-day or digest reader counts it as a stall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerDecision, skipGroupOf } from './skip-reasons';
import { classifyClose } from '../series-pause/skip-cause';
import { CONNECTOR_SKIP_PREFIX, OWNER_CHAT_SKIP_PREFIX, OWNER_SKIP_PREFIX, OWNER_SKIP_PREFIXES, connectorSkipError, isOwnerSkip } from '../repo/slot-lock';

const ERRORS = [
  OWNER_SKIP_PREFIX, `${OWNER_SKIP_PREFIX}: not today`, OWNER_CHAT_SKIP_PREFIX, CONNECTOR_SKIP_PREFIX, `${CONNECTOR_SKIP_PREFIX}: changed my mind`,
  connectorSkipError('  too   late '),
];

test('every owner skip prefix is an owner decision and classifies as ignore for the breaker and the controller', () => {
  for (const e of ERRORS) {
    assert.equal(isOwnerSkip(e), true, e);
    assert.equal(isOwnerDecision(e), true, e);
    assert.deepEqual(classifyClose({ status: 'skipped', error: e, criticVerdict: null }), { k: 'ignore' }, e);
  }
  for (const p of OWNER_SKIP_PREFIXES) assert.equal(isOwnerDecision(p), true);
});

test('what is not an owner skip stays what it was (an agent skip, a miss, a rejection)', () => {
  assert.equal(isOwnerDecision('skipped by agent: no_material: nothing'), false);
  assert.equal(isOwnerDecision('skipped by ownership'), false);
  assert.equal(isOwnerDecision('stale: missed its time window'), false);
  assert.equal(isOwnerDecision('rejected by owner'), true, 'the existing owner decision is unchanged');
  assert.equal(classifyClose({ status: 'skipped', error: 'no_fresh_item: nothing', criticVerdict: null }).k, 'cause');
  assert.equal(skipGroupOf('skipped by owner (connector)'), 'other');
});

test('connectorSkipError trims and caps the reason', () => {
  assert.equal(connectorSkipError(), CONNECTOR_SKIP_PREFIX);
  assert.equal(connectorSkipError('  too   late '), `${CONNECTOR_SKIP_PREFIX}: too late`);
  assert.equal(connectorSkipError('x'.repeat(500)).length, CONNECTOR_SKIP_PREFIX.length + 2 + 300);
});
