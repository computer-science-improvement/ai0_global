// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnauthorizedHandler } from './unauthorized';
import { api, ApiError, setUnauthorizedHandler } from '../api/client';

function harness(href = '/app/editor?x=1') {
  const resets: (string | null)[] = [];
  const navs: { next?: string; reason?: string }[] = [];
  let current = href;
  let release: () => void = () => undefined;
  const handler = createUnauthorizedHandler({
    resetSession: (r) => resets.push(r),
    navigateToLogin: (search) => {
      navs.push(search);
      return new Promise<void>((resolve) => { release = () => { current = '/login'; resolve(); }; });
    },
    currentHref: () => current,
  });
  return { handler, resets, navs, finish: () => release(), setHref: (h: string) => { current = h; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('many 401s at once → one navigation with next + reason; every 401 resets the session', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.handler('session_revoked');
  await tick();
  assert.deepEqual(h.navs, [{ next: '/app/editor?x=1', reason: 'session_revoked' }]);
  assert.equal(h.resets.length, 5);
  h.finish();
  await tick();
  h.handler('session_revoked');          // now on /login: no second navigation
  await tick();
  assert.equal(h.navs.length, 1);
});

test('a later 401 after coming back to /app navigates again', async () => {
  const h = harness();
  h.handler(null);
  await tick();
  h.finish();
  await tick();
  h.setHref('/app/channels');
  h.handler('session_expired');
  await tick();
  assert.deepEqual(h.navs[1], { next: '/app/channels', reason: 'session_expired' });
  assert.deepEqual(h.navs[0], { next: '/app/editor?x=1' }, 'no reason key without a code');
});

test('outside /app (landing, public report) a 401 does not navigate', async () => {
  for (const href of ['/', '/report/abc', '/login?next=%2Fapp', '/applications']) {
    const h = harness(href);
    h.handler('no_credentials');
    await tick();
    assert.equal(h.navs.length, 0, href);
    assert.equal(h.resets.length, 1);
  }
});

test('api(): a 401 reports the body code to the handler and still throws ApiError(401)', async () => {
  const seen: (string | null)[] = [];
  setUnauthorizedHandler((r) => seen.push(r));
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ statusCode: 401, code: 'session_expired', message: 'x' }), { status: 401 })) as typeof fetch;
    await assert.rejects(() => api('/api/x'), (e: unknown) => e instanceof ApiError && e.status === 401 && e.message === 'session_expired');
    globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
    await assert.rejects(() => api('/api/x'), (e: unknown) => e instanceof ApiError && e.status === 401);
    assert.deepEqual(seen, ['session_expired', null]);
  } finally {
    globalThis.fetch = realFetch;
    setUnauthorizedHandler(() => undefined);
  }
});

test('api() + handler: three parallel 401s → one navigation', async () => {
  const h = harness('/app');
  setUnauthorizedHandler(h.handler);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 'session_revoked' }), { status: 401 })) as typeof fetch;
    const results = await Promise.allSettled([api('/a'), api('/b'), api('/c')]);
    assert.ok(results.every((r) => r.status === 'rejected'));
    await tick();
    assert.equal(h.navs.length, 1);
    assert.equal(h.resets.length, 3);
  } finally {
    globalThis.fetch = realFetch;
    setUnauthorizedHandler(() => undefined);
  }
});
