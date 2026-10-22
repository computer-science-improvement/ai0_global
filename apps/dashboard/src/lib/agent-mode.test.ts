import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followedMode, followsText, followsTitle } from './agent-mode';

test('the badge says whom a role agent follows and in which mode', () => {
  assert.equal(followsText('pdr', 'live'), 'Follows @pdr (live)');
  assert.equal(followsText('ai0_global', 'approve'), 'Follows @ai0_global (in approval)');
  assert.equal(followsText('pdr', 'off'), 'Follows @pdr (off)');
});

test('the tooltip explains why there is no mode switch and where to change it', () => {
  const t = followsTitle('pdr_planner', 'pdr', 'live');
  assert.match(t, /^@pdr_planner has no mode of its own\./);
  assert.match(t, /Change the mode on @pdr\.$/);
});

test('the followed mode is the effective one the API sends, not the child\'s stored column', () => {
  assert.equal(followedMode({ effectiveMode: 'live', mode: 'off' }), 'live');
  assert.equal(followedMode({ mode: 'off' }, { mode: 'approve' }), 'approve');
  assert.equal(followedMode({ mode: 'shadow' }), 'shadow');
});
