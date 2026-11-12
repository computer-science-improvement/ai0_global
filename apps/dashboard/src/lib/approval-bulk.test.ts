import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkApprovable, bulkApproveToast } from './approval-bulk';

const post = (o: Record<string, unknown> = {}) => ({ lintWarnings: [], critic: null, ...o });
const held = () => false;

test('D3: locked posts are not counted as approvable', () => {
  const waiting = [post(), post(), post(), post({ lockedBy: 'connector' }), post({ lockedBy: 'owner' })];
  assert.equal(bulkApprovable(waiting, held), 3);
  assert.equal(bulkApprovable([post({ lockedBy: 'connector' })], held), 0);
});

test('D3: the toast says locked posts are approved one by one', () => {
  assert.equal(bulkApproveToast({ approved: 3, skippedWithWarnings: 0, conflicts: 0, skippedLocked: 2 }, 'X'),
    'Approved 3 posts (X); 2 locked posts: approve them one by one');
  assert.equal(bulkApproveToast({ approved: 1, skippedWithWarnings: 0, conflicts: 0 }, 'X'), 'Approved 1 post (X)');
});
