import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { MetaGraphClient } from './meta-graph.client';

afterEach(() => mock.restoreAll());

function client() {
  const config = { get: (k: string) => ({ META_GRAPH_VERSION: 'v21.0', THREADS_GRAPH_VERSION: 'v1.0', FETCH_TIMEOUT: '15000' } as any)[k] };
  return new MetaGraphClient(config as any);
}

// Graph metric response body: { data: [ { name, period, values: [{value, end_time}] } ] }
function graphBody(name: string, pairs: [string, number][]) {
  return { data: [{ name, period: 'day', values: pairs.map(([end_time, value]) => ({ value, end_time })) }] };
}

test('instagram: per-metric calls merge into normalized days; a failing metric → null', async () => {
  mock.method(axios, 'get', async (_url: string, opts: any) => {
    const metric = opts.params.metric;
    if (metric === 'reach')         return { data: graphBody('reach', [['2026-06-10T07:00:00+0000', 100]]) };
    if (metric === 'profile_views') return { data: graphBody('profile_views', [['2026-06-10T07:00:00+0000', 5]]) };
    if (metric === 'impressions')   throw new Error('metric impressions is deprecated'); // isolated → null
    throw new Error('unexpected metric ' + metric);
  });
  const out = await client().fetchInsights('instagram', 'IG1', 'tok', 7);
  assert.deepEqual(out, [{ day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 }]);
});

test('threads: views maps to impressions; reach/profileViews stay null; uses threads host+edge', async () => {
  mock.method(axios, 'get', async (url: string, opts: any) => {
    assert.match(url, /graph\.threads\.net/);
    assert.match(url, /\/threads_insights$/);
    assert.equal(opts.params.metric, 'views');
    return { data: graphBody('views', [['2026-06-10T07:00:00+0000', 42]]) };
  });
  const out = await client().fetchInsights('threads', 'TH1', 'tok', 7);
  assert.deepEqual(out, [{ day: '2026-06-10', reach: null, impressions: 42, profileViews: null }]);
});

test('returns [] when token or targetId is missing', async () => {
  assert.deepEqual(await client().fetchInsights('instagram', 'IG1', '', 7), []);
  assert.deepEqual(await client().fetchInsights('instagram', '', 'tok', 7), []);
});

test('fetchThreadsFollowers reads total_value from threads_insights', async () => {
  mock.method(axios, 'get', async (url: string, opts: any) => {
    assert.match(url, /graph\.threads\.net/);
    assert.match(url, /\/threads_insights$/);
    assert.equal(opts.params.metric, 'followers_count');
    return { data: { data: [{ name: 'followers_count', total_value: { value: 2 } }] } };
  });
  assert.equal(await client().fetchThreadsFollowers('TH1', 'tok'), 2);
});

test('fetchThreadsFollowers returns null on error or missing value', async () => {
  mock.method(axios, 'get', async () => { throw new Error('no insights scope'); });
  assert.equal(await client().fetchThreadsFollowers('TH1', 'tok'), null);
  assert.equal(await client().fetchThreadsFollowers('', 'tok'), null);
});

test('inspectToken parses debug_token payload: type/scopes/isValid and expiresAt as Date', async () => {
  mock.method(axios, 'get', async (url: string, opts: any) => {
    assert.match(url, /graph\.facebook\.com\/v21\.0\/debug_token$/);
    // self-inspection: input_token === access_token === the token under test
    assert.equal(opts.params.input_token, 'tok');
    assert.equal(opts.params.access_token, 'tok');
    return { data: { data: {
      type: 'PAGE', expires_at: 1786884952, data_access_expires_at: 1789476951,
      scopes: ['pages_manage_posts'], is_valid: true,
    } } };
  });
  const out = await client().inspectToken('tok');
  assert.ok(out);
  assert.equal(out!.type, 'PAGE');
  assert.deepEqual(out!.scopes, ['pages_manage_posts']);
  assert.equal(out!.isValid, true);
  assert.ok(out!.expiresAt instanceof Date);
  assert.equal(out!.expiresAt!.getTime(), 1786884952 * 1000);
  assert.ok(out!.dataAccessExpiresAt instanceof Date);
  assert.equal(out!.dataAccessExpiresAt!.getTime(), 1789476951 * 1000);
});

test('inspectToken: expires_at 0 → null (never expires); missing scopes → []', async () => {
  mock.method(axios, 'get', async () => ({ data: { data: {
    type: 'SYSTEM_USER', expires_at: 0, data_access_expires_at: 0, is_valid: true,
  } } }));
  const out = await client().inspectToken('tok');
  assert.ok(out);
  assert.equal(out!.expiresAt, null);
  assert.equal(out!.dataAccessExpiresAt, null);
  assert.deepEqual(out!.scopes, []);
  assert.equal(out!.type, 'SYSTEM_USER');
});

test('inspectToken returns null on error (best-effort) and does not leak the token', async () => {
  let logged = '';
  const cfg = { get: (k: string) => ({ META_GRAPH_VERSION: 'v21.0', FETCH_TIMEOUT: '15000' } as any)[k] };
  const c = new MetaGraphClient(cfg as any);
  // capture anything the client tries to log
  (c as any).logger = { debug: (m: string) => { logged += m; }, warn: (m: string) => { logged += m; }, error: (m: string) => { logged += m; } };
  mock.method(axios, 'get', async () => { throw new Error('debug_token failed for access_token=SECRET_TOKEN_VALUE'); });
  const out = await c.inspectToken('SECRET_TOKEN_VALUE');
  assert.equal(out, null);
  assert.equal(logged.includes('SECRET_TOKEN_VALUE'), false);
});

// ── refreshThreadsToken (Part 2) ──────────────────────────────────────────────

test('refreshThreadsToken returns the new token + expiry from graph.threads.net', async () => {
  let calledUrl = ''; let calledParams: any;
  mock.method(axios, 'get', async (url: string, opts: any) => {
    calledUrl = url; calledParams = opts.params;
    return { data: { access_token: 'NEW_LONG_LIVED', token_type: 'bearer', expires_in: 5184000 } };
  });
  const out = await client().refreshThreadsToken('OLD_TOKEN');
  assert.match(calledUrl, /graph\.threads\.net\/refresh_access_token/);
  assert.equal(calledParams.grant_type, 'th_refresh_token');
  assert.equal(calledParams.access_token, 'OLD_TOKEN');
  assert.deepEqual(out, { accessToken: 'NEW_LONG_LIVED', expiresInSec: 5184000 });
});

test('refreshThreadsToken throws a token-redacted error on failure', async () => {
  mock.method(axios, 'get', async () => { throw new Error('boom for access_token=SECRET_TOKEN_VALUE'); });
  await assert.rejects(
    () => client().refreshThreadsToken('SECRET_TOKEN_VALUE'),
    (err: Error) => {
      assert.match(err.message, /refreshThreadsToken failed/);
      assert.equal(err.message.includes('SECRET_TOKEN_VALUE'), false, 'token must be redacted');
      return true;
    },
  );
});
