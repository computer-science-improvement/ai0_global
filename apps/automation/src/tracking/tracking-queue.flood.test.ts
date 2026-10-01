import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DelayedError } from 'bullmq';
import { withFloodWaitPolicy } from './tracking-queue.service';
import { FloodWaitActiveError } from '../common/telegram/flood-wait';

// Pure wrapper test — no Redis. A fake job records moveToDelayed() calls.
function fakeJob() {
  const moves: Array<{ ts: number; token?: string }> = [];
  const job: any = { id: 'j1', moveToDelayed: async (ts: number, token?: string) => { moves.push({ ts, token }); } };
  return { job, moves };
}

test('flood-wait from the processor delays the job by the wait and throws DelayedError', async () => {
  const { job, moves } = fakeJob();
  const now = 5_000_000;
  const wrapped = withFloodWaitPolicy('poll-posts', async () => { throw new FloodWaitActiveError(90, 'getHistory'); }, undefined, () => now);
  await assert.rejects(() => wrapped(job, 'tok'), DelayedError);
  assert.deepEqual(moves, [{ ts: now + 90_000, token: 'tok' }]);
});

test('non-flood errors propagate unchanged (normal BullMQ retry/backoff)', async () => {
  const { job, moves } = fakeJob();
  const wrapped = withFloodWaitPolicy('poll-posts', async () => { throw new Error('db down'); });
  await assert.rejects(() => wrapped(job, 'tok'), /db down/);
  assert.equal(moves.length, 0);
});

test('success passes the result through', async () => {
  const { job } = fakeJob();
  const wrapped = withFloodWaitPolicy('poll-posts', async () => 'done');
  assert.equal(await wrapped(job, 'tok'), 'done');
});

test('without a lock token the flood error is rethrown (cannot move the job)', async () => {
  const { job, moves } = fakeJob();
  const wrapped = withFloodWaitPolicy('poll-posts', async () => { throw new FloodWaitActiveError(5, 'x'); });
  await assert.rejects(() => wrapped(job, undefined), FloodWaitActiveError);
  assert.equal(moves.length, 0);
});

test("policy 'skip': flood-wait completes the job (logged) without moving it", async () => {
  const { job, moves } = fakeJob();
  const wrapped = withFloodWaitPolicy('poll-meta', async () => { throw new FloodWaitActiveError(600, 'getFullChannel'); }, undefined, Date.now, 'skip');
  assert.equal(await wrapped(job, 'tok'), undefined);
  assert.equal(moves.length, 0);
});

test("policy 'skip': non-flood errors still propagate", async () => {
  const { job } = fakeJob();
  const wrapped = withFloodWaitPolicy('poll-meta', async () => { throw new Error('boom'); }, undefined, Date.now, 'skip');
  await assert.rejects(() => wrapped(job, 'tok'), /boom/);
});
