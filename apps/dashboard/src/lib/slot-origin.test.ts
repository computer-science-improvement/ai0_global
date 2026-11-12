import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConnectorChat, isLockedSlot, lockedLabel, lockedTooltip, originFacts, originLabel, originTooltip } from './slot-origin';

test('a plain slot has no origin, no lock and no text', () => {
  for (const s of [{}, null, undefined, { createdVia: null, lockedBy: null }]) {
    assert.equal(originLabel(s), null);
    assert.equal(lockedLabel(s), null);
    assert.equal(originTooltip(s), '');
    assert.equal(lockedTooltip(s), '');
    assert.equal(originFacts(s), '');
    assert.equal(isLockedSlot(s), false);
  }
});

test('a connector slot is labelled and locked', () => {
  const s = { createdVia: 'connector' as const, lockedBy: 'connector' as const, lockedAt: '2030-01-01T00:00:00Z' };
  assert.equal(originLabel(s), 'connector');
  assert.equal(lockedLabel(s), 'locked');
  assert.match(lockedTooltip(s), /from Claude/);
  assert.equal(originFacts(s), 'via connector · locked');
});

test('an agent slot the owner locked is locked but not a connector slot', () => {
  const s = { lockedBy: 'owner' as const };
  assert.equal(originLabel(s), null);
  assert.equal(lockedLabel(s), 'locked');
  assert.match(lockedTooltip(s), /by you/);
  assert.equal(originFacts(s), 'locked');
});

test('chats created through the connector are recognised', () => {
  assert.equal(isConnectorChat({ createdVia: 'connector' }), true);
  assert.equal(isConnectorChat({ createdVia: null }), false);
  assert.equal(isConnectorChat({}), false);
});
