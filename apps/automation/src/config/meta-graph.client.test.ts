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
