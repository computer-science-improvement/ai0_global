// Spec 048 FR-004: the chat list's date groups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatGroup } from './chat-groups';

test('chats group by local day: today, yesterday, the previous 7 days, older', () => {
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(chatGroup(new Date(2026, 9, 18, 0, 5).toISOString(), now), 'Today');
  assert.equal(chatGroup(new Date(2026, 9, 17, 23, 59).toISOString(), now), 'Yesterday');
  assert.equal(chatGroup(new Date(2026, 9, 12, 12, 0).toISOString(), now), 'Previous 7 days');
  assert.equal(chatGroup(new Date(2026, 9, 11, 12, 0).toISOString(), now), 'Older');
  assert.equal(chatGroup(new Date(2026, 9, 19, 1, 0).toISOString(), now), 'Today', 'a clock a little ahead is still today');
});
