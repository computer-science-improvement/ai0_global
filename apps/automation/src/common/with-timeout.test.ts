import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from './with-timeout';

test('withTimeout resolves when the promise settles in time', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, 'x'), 42);
});

test('withTimeout rejects with a labelled error when the deadline passes', async () => {
  // A promise that settles far later than the deadline. Its ref'd timer keeps
  // the event loop alive so the (unref'd) timeout timer actually fires — and
  // it mirrors the real case: a slow external call losing to the deadline.
  const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 500));
  await assert.rejects(withTimeout(slow, 20, 'getMe'), /getMe timed out after 20ms/);
});

test('withTimeout propagates the original rejection', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('boom')), 1000, 'x'),
    /boom/,
  );
});
