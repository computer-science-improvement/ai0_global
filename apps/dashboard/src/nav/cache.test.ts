// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 FR-015: the first-paint cache survives garbage and missing storage.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_CACHE_KEY, readNavCache, writeNavCache } from './cache';
import { NAV_REGISTRY } from './registry';
import { resolveNav } from './resolve';

const g = globalThis as any;
afterEach(() => { delete g.localStorage; });

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

test('a written response reads back and resolves to the saved menu (no flash of the default)', () => {
  g.localStorage = memoryStorage();
  const config = { schemaVersion: 1, groups: [{ id: 'g_home', items: ['overview', 'chat'] }], pinned: ['chat'], hidden: [], custom: [], overrides: {} };
  writeNavCache({ config, revision: '2026-10-06 09:00:00+00' });
  const back = readNavCache();
  assert.deepEqual(back, { config, revision: '2026-10-06 09:00:00+00' });
  assert.deepEqual(resolveNav(NAV_REGISTRY, back!.config).pinned.map((i) => i.id), ['chat']);
});

test('no storage, blocked storage or garbage → undefined (the default renders until GET resolves)', () => {
  assert.equal(readNavCache(), undefined, 'no localStorage at all');
  writeNavCache({ config: null, revision: null });
  g.localStorage = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
  assert.equal(readNavCache(), undefined);
  assert.doesNotThrow(() => writeNavCache({ config: null, revision: null }));
  const s = memoryStorage();
  g.localStorage = s;
  for (const raw of ['{', '42', '{"config":{}}', 'null']) {
    s.m.set(NAV_CACHE_KEY, raw);
    assert.equal(readNavCache(), undefined, raw);
  }
});
