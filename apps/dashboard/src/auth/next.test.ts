// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// node:test instead of vitest: the dashboard has no test runner installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginRedirectTarget, parseNext, safeAppPath } from './next';

test('parseNext: router-encoded form', () => {
  assert.equal(parseNext('?next=%2Fapp%2Feditor'), '/app/editor');
  assert.equal(parseNext('?next=%2Fapp%2Fagents%2F%40manager%3Ftab%3Dinbox&reason=session_expired'), '/app/agents/@manager?tab=inbox');
  assert.equal(parseNext('next=%2Fapp'), '/app');
  assert.equal(parseNext('?reason=x&next=%2Fapp%2Fchannels'), '/app/channels');
  assert.equal(parseNext('?next=%22%2Fapp%2Fx%22'), '/app/x', 'JSON-quoted string');
});

test('parseNext: nginx raw $request_uri remainder, query and all', () => {
  assert.equal(parseNext('?reason=no_credentials&next=/app/editor'), '/app/editor');
  assert.equal(parseNext('?reason=&next=/app/agents/@manager?tab=inbox&x=1'), '/app/agents/@manager?tab=inbox&x=1');
  assert.equal(parseNext('?reason=session_expired&next=/app'), '/app');
  assert.equal(parseNext('?next=/app/agents/%40manager'), '/app/agents/%40manager');
});

test('parseNext: hostile or foreign targets fall back to /app', () => {
  const hostile = [
    '?next=https%3A%2F%2Fevil.com', '?next=//evil.com', '?next=%2F%2Fevil.com', '?next=/\\evil.com',
    '?next=%2F%5Cevil.com', '?next=javascript%3Aalert(1)', '?next=/apple', '?next=/application',
    '?next=/app@evil.com', '?next=/login', '?next=/', '?next=/app//evil.com', '?next=%2Fapp%0A%2Fx',
    '?next=/app%20x', '?next=%E0%A4%A', '?next=', '?foo=1', '', '?next=%22%2F%2Fevil%22',
  ];
  for (const h of hostile) assert.equal(parseNext(h), '/app', h);
  assert.equal(parseNext(null), '/app');
  assert.equal(parseNext(undefined), '/app');
});

test('safeAppPath: only same-origin /app paths', () => {
  assert.equal(safeAppPath('/app'), '/app');
  assert.equal(safeAppPath('/app/'), '/app/');
  assert.equal(safeAppPath('/app#x'), '/app#x');
  assert.equal(safeAppPath('/app?x=1'), '/app?x=1');
  assert.equal(safeAppPath('/apps'), null);
  assert.equal(safeAppPath('app'), null);
});

test('/login sends a signed-in browser to the safe next; shows the form otherwise', () => {
  const me = { me: { tgUserId: 0, firstName: 'Operator' } };
  assert.equal(loginRedirectTarget(me, '?next=%2Fapp%2Feditor'), '/app/editor');
  assert.equal(loginRedirectTarget(me, '?next=https%3A%2F%2Fevil.com'), '/app');
  assert.equal(loginRedirectTarget(me, ''), '/app');
  assert.equal(loginRedirectTarget({ me: null }, '?next=%2Fapp%2Feditor'), null);
  assert.equal(loginRedirectTarget(null, ''), null);
});
