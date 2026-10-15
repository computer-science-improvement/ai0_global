import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentText, draftError, errorText, filterSettings, valueText } from './settings-catalog';
import type { SettingState } from '../api/settings';

const s = (o: Partial<SettingState>): SettingState => ({
  key: 'K', group: 'g', label: 'Label', help: 'Help', type: 'string', apply: 'live', default: '', value: null, set: false,
  source: 'default', updatedAt: null, pendingRestart: false, envValue: null, decryptFailed: false, ...o,
});

test('filterSettings: group and a query on label, key or help', () => {
  const list = [s({ key: 'POSTING_COOLDOWN_MIN', group: 'publishing', label: 'Telegram cooldown' }), s({ key: 'AGENT_ENABLED', group: 'agent', label: 'Inbox agent', help: 'Reads the inbox' })];
  assert.deepEqual(filterSettings(list, { group: 'agent' }).map((x) => x.key), ['AGENT_ENABLED']);
  assert.deepEqual(filterSettings(list, { query: 'cooldown' }).map((x) => x.key), ['POSTING_COOLDOWN_MIN']);
  assert.deepEqual(filterSettings(list, { query: 'agent_en' }).map((x) => x.key), ['AGENT_ENABLED']);
  assert.deepEqual(filterSettings(list, { query: 'inbox', group: 'publishing' }), []);
  assert.equal(filterSettings(list, {}).length, 2);
});

test('valueText / currentText: bools by their on value, secrets never shown, defaults named', () => {
  const critic = s({ type: 'bool', bool: { on: 'on', off: 'off' }, default: 'on' });
  assert.equal(valueText(critic, 'off'), 'Off');
  assert.equal(valueText(critic, null), 'On', 'unset → the default');
  assert.equal(currentText(s({ type: 'secret', set: true })), 'set');
  assert.equal(valueText(s({ type: 'secret' }), 'sk-x'), 'set');
  assert.equal(currentText(s({ type: 'int', default: '20' })), 'default (20)');
  assert.equal(currentText(s({ type: 'int', default: '20', value: '25', set: true })), '25');
});

test('draftError and errorText', () => {
  const n = s({ type: 'int', min: 1, max: 10 });
  assert.equal(draftError(n, '5'), null);
  assert.equal(draftError(n, '0'), 'At least 1');
  assert.equal(draftError(n, '2.5'), 'A whole number');
  assert.equal(draftError(n, ''), 'Enter a value, or use Reset');
  assert.equal(draftError(s({ type: 'url' }), 'ftp://x'), 'An http(s) URL');
  assert.equal(errorText(new Error('{"error":"invalid_value","message":"Telegram cooldown: must be ≥ 1"}')), 'Telegram cooldown: must be ≥ 1');
  assert.equal(errorText(new Error('boom')), 'boom');
});
