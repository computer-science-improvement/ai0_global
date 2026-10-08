import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_KEY, ModelDefaultsStore, readDefaultModel } from './model-defaults';

function fakePool(initial: string | null) {
  let value = initial;
  let fail = false;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    set value(v: string | null) { value = v; },
    set fail(f: boolean) { fail = f; },
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (fail) throw new Error('db down');
      if (/^SELECT/.test(sql.trim())) return { rows: value == null ? [] : [{ value }] };
      if (/^INSERT/.test(sql.trim())) { value = String(params[1]); return { rows: [] }; }
      if (/^DELETE/.test(sql.trim())) { value = null; return { rows: [] }; }
      throw new Error(`unexpected ${sql}`);
    },
  };
}

test('ai.default_model: absent → null; cached for the TTL; set() updates the cache without a re-read', async () => {
  const pool = fakePool(null);
  let now = 1_000;
  const store = new ModelDefaultsStore(pool as any,{ ttlMs: 60_000, now: () => now });
  assert.equal(await store.get(), null);
  assert.equal(await store.get(), null);
  assert.equal(pool.calls.filter((c) => c.sql.startsWith('SELECT')).length, 1, 'cached');
  assert.deepEqual(pool.calls[0].params, [DEFAULT_MODEL_KEY]);

  await store.set('openai/gpt-5-mini');
  assert.equal(await store.get(), 'openai/gpt-5-mini');
  assert.equal(pool.calls.filter((c) => c.sql.startsWith('SELECT')).length, 1, 'save invalidates in place, no re-read');

  // Another process changed it: seen after the TTL.
  pool.value = 'x/other';
  now += 59_000;
  assert.equal(await store.get(), 'openai/gpt-5-mini');
  now += 2_000;
  assert.equal(await store.get(), 'x/other');

  await store.set(null);
  assert.ok(pool.calls.some((c) => c.sql.startsWith('DELETE')));
  assert.equal(await store.get(), null);
});

test('a failed read keeps the last value; readDefaultModel never throws', async () => {
  const pool = fakePool('a/b');
  let now = 0;
  const errors: string[] = [];
  const store = new ModelDefaultsStore(pool as any,{ ttlMs: 10, now: () => now, onError: (m) => errors.push(m) });
  assert.equal(await store.get(), 'a/b');
  pool.fail = true;
  now = 100;
  assert.equal(await store.get(), 'a/b');
  assert.equal(errors.length, 1);
  assert.equal(await readDefaultModel(undefined), null);
  assert.equal(await readDefaultModel(async () => { throw new Error('x'); }), null);
  assert.equal(await readDefaultModel(() => store.get()), 'a/b');
});

test('set() failure leaves the cache unchanged', async () => {
  const pool = fakePool('a/b');
  const store = new ModelDefaultsStore(pool as any);
  assert.equal(await store.get(), 'a/b');
  pool.fail = true;
  await assert.rejects(store.set('c/d'));
  assert.equal(await store.get(), 'a/b');
});
