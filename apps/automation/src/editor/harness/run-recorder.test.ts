import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgRunRecorder } from './run-recorder';

function fakePool(fail = false) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: any[]) => {
        calls.push({ sql, params });
        if (fail && /editor_run_steps/.test(sql)) throw new Error('boom');
        return { rows: [{ id: 'run-1' }], rowCount: 1 };
      },
    } as any,
  };
}

test('start inserts a run and returns id', async () => {
  const { pool, calls } = fakePool();
  const id = await new PgRunRecorder(pool).start({ role: 'executor', channelKey: 'ch', slotId: 's1', model: 'm' });
  assert.equal(id, 'run-1');
  assert.match(calls[0].sql, /INSERT INTO editor_runs/);
  assert.deepEqual(calls[0].params, ['executor', 'ch', 's1', 'm']);
});

test('llmStep records usage', async () => {
  const { pool, calls } = fakePool();
  await new PgRunRecorder(pool).llmStep('r', 0, {
    message: { role: 'assistant', content: 'hi' }, finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 2, costUsd: 0.001 },
  }, 50);
  assert.match(calls[0].sql, /INSERT INTO editor_run_steps/);
  assert.equal(calls[0].params[2], 'llm');
  assert.equal(calls[0].params[7], 10);
  assert.equal(calls[0].params[9], 0.001);
});

test('toolStep failure is swallowed and reported', async () => {
  const { pool } = fakePool(true);
  const errors: string[] = [];
  await new PgRunRecorder(pool, (m) => errors.push(m))
    .toolStep('r', 1, { id: 'c', name: 't', arguments: '{}' }, {}, { ok: 1 }, false, 5);
  assert.equal(errors.length, 1);
});

test('finish writes totals', async () => {
  const { pool, calls } = fakePool();
  await new PgRunRecorder(pool).finish('r', 'ok', { steps: 3, promptTokens: 30, completionTokens: 6, costUsd: 0.01 });
  assert.match(calls[0].sql, /UPDATE editor_runs/);
  assert.deepEqual(calls[0].params, ['r', 'ok', 3, 30, 6, 0.01, null]);
});
