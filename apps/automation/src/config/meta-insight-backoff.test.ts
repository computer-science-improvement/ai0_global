import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  graphErrorText, MetaInsightBackoff, METRIC_BACKOFF_MS, isMetricUnsupported, REPEATED_400_BACKOFF_MS, REPEATED_400_LIMIT, UNCOUNTED_GRAPH_CODES,
} from './meta-insight-backoff';

test('isMetricUnsupported: only HTTP 400 answers that name the metric', () => {
  const e = (status: number, message: string, code?: number) => ({ response: { status, data: { error: { message, code } } } });
  assert.equal(isMetricUnsupported(e(400, 'The metric impressions is deprecated')), true);
  assert.equal(isMetricUnsupported(e(400, 'whatever', 100)), true);
  assert.equal(isMetricUnsupported(e(400, 'Invalid OAuth access token', 190)), false);
  assert.equal(isMetricUnsupported(e(500, 'metric not supported')), false);
  assert.equal(isMetricUnsupported(new Error('timeout')), false);
});

test('backoff: remembered for 7 days, per account and metric, logged once a day', () => {
  let now = Date.parse('2026-10-22T10:00:00Z');
  const b = new MetaInsightBackoff(() => now);
  assert.equal(b.skipped('facebook', 'F1', 'm'), false);
  assert.equal(b.remember('facebook', 'F1', 'm'), true, 'first time: log');
  assert.equal(b.remember('facebook', 'F1', 'm'), false, 'same day: no log');
  assert.equal(b.skipped('facebook', 'F1', 'm'), true);
  assert.equal(b.skipped('facebook', 'F2', 'm'), false);
  assert.equal(b.skipped('facebook', 'F1', 'other'), false);
  now += METRIC_BACKOFF_MS - 1;
  assert.equal(b.skipped('facebook', 'F1', 'm'), true);
  now += 2;
  assert.equal(b.skipped('facebook', 'F1', 'm'), false, 'asks again after 7 days');
  assert.equal(b.remember('facebook', 'F1', 'm'), true, 'a new day logs again');
});

// ── spec 070 FR-006: three plain 400s in a row back a metric off for a day ───────────────────────────────────────────

const graph = (status: number, code?: number, extra: Record<string, unknown> = {}) => ({
  response: { status, data: { error: { message: 'm', code, ...extra } } },
});

test('spec 070 failed(): the third 400 in a row backs off for 24 h, then one request a day; the warning is once per UTC day', () => {
  let now = Date.parse('2026-10-26T10:00:00Z');
  const b = new MetaInsightBackoff(() => now);
  assert.equal(REPEATED_400_LIMIT, 3);
  assert.deepEqual(b.failed('facebook', 'F1', 'm', graph(400, 10)), { count: 1, backedOff: false, log: false });
  assert.deepEqual(b.failed('facebook', 'F1', 'm', graph(400, 10)), { count: 2, backedOff: false, log: false });
  assert.equal(b.skipped('facebook', 'F1', 'm'), false, 'two are not enough');
  assert.deepEqual(b.failed('facebook', 'F1', 'm', graph(400, 10)), { count: 3, backedOff: true, log: true });
  assert.equal(b.skipped('facebook', 'F1', 'm'), true);
  assert.equal(b.skipped('facebook', 'F2', 'm'), false, 'another account');
  assert.equal(b.skipped('facebook', 'F1', 'other'), false, 'another metric');
  now += REPEATED_400_BACKOFF_MS - 1;
  assert.equal(b.skipped('facebook', 'F1', 'm'), true);
  now += 2;
  assert.equal(b.skipped('facebook', 'F1', 'm'), false, 'one request a day');
  // That request fails again: the back-off is set again at once; it is a new UTC day, so it is logged again.
  assert.deepEqual(b.failed('facebook', 'F1', 'm', graph(400, 10)), { count: 4, backedOff: true, log: true });
  assert.equal(b.skipped('facebook', 'F1', 'm'), true);
  // A further failure on the same UTC day does not log twice.
  now = Date.parse('2026-10-28T10:00:00Z') + 1_000;
  assert.equal(b.skipped('facebook', 'F1', 'm'), false);
  assert.equal(b.failed('facebook', 'F1', 'm', graph(400, 10)).log, true);
  assert.equal(b.failed('facebook', 'F1', 'm', graph(400, 10)).log, false, 'the same UTC day');
});

test('spec 070 failed(): 190 and the rate-limit / transient codes are not counted; neither are non-400 answers', () => {
  const b = new MetaInsightBackoff(() => 0);
  for (const code of [190, 1, 2, 4, 17, 32, 613]) {
    assert.ok(UNCOUNTED_GRAPH_CODES.has(code), String(code));
    for (let i = 0; i < 5; i++) assert.deepEqual(b.failed('facebook', 'F1', `m${code}`, graph(400, code)), { count: 0, backedOff: false, log: false });
    assert.equal(b.skipped('facebook', 'F1', `m${code}`), false, `code ${code} never backs off`);
  }
  for (const err of [graph(500, 10), graph(503), graph(429, 4), new Error('socket hang up'), null, undefined]) {
    assert.equal(b.failed('facebook', 'F1', 'x', err).count, 0);
  }
  assert.equal(b.skipped('facebook', 'F1', 'x'), false);
});

test('spec 070 failed(): a 5xx or a network error leaves the count; a success starts it again', () => {
  const b = new MetaInsightBackoff(() => 0);
  b.failed('facebook', 'F1', 'm', graph(400, 10));
  b.failed('facebook', 'F1', 'm', graph(400, 10));
  assert.equal(b.failed('facebook', 'F1', 'm', graph(502)).count, 2, 'unchanged');
  assert.equal(b.failed('facebook', 'F1', 'm', new Error('ETIMEDOUT')).count, 2);
  assert.equal(b.failed('facebook', 'F1', 'm', graph(400, 10)).backedOff, true, 'the third 400 counts, the 5xx in between did not reset');

  const c = new MetaInsightBackoff(() => 0);
  c.failed('facebook', 'F1', 'm', graph(400, 10));
  c.failed('facebook', 'F1', 'm', graph(400, 10));
  c.ok('facebook', 'F1', 'm');
  assert.equal(c.failed('facebook', 'F1', 'm', graph(400, 10)).count, 1, 'a success started the count again');
  assert.equal(c.failed('facebook', 'F1', 'm', graph(400, 10)).backedOff, false);
  assert.equal(c.failed('facebook', 'F1', 'm', graph(400, 10)).backedOff, true);
  // Success on another metric or account does not reset this one.
  c.ok('facebook', 'F2', 'm');
  c.ok('facebook', 'F1', 'other');
  assert.equal(c.failed('facebook', 'F1', 'm', graph(400, 10)).count, 4);
});

test('spec 070 graphErrorText(): status, code/subcode, type, message and fbtrace_id; token redacted; at most 200 characters', () => {
  const full = {
    response: { status: 400, data: { error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10, error_subcode: 2108006, fbtrace_id: 'AbC123xyz' } } },
  };
  assert.equal(graphErrorText(full),
    'status 400 code=10/2108006 OAuthException: (#10) Application does not have permission for this action (fbtrace_id AbC123xyz)');
  assert.equal(graphErrorText({ response: { status: 400, data: { error: { message: 'bad', code: 100 } } } }), 'status 400 code=100: bad');
  // The token in a message is redacted, and a long message is cut while the trace id is kept.
  const long = { response: { status: 400, data: { error: { message: `GET https://graph.facebook.com/v21.0/1/insights?metric=x&access_token=EAAB123secret failed ${'because '.repeat(60)}`, type: 'GraphMethodException', code: 3, fbtrace_id: 'TRACE9' } } } };
  const t = graphErrorText(long);
  assert.ok(t.length <= 200, `length ${t.length}`);
  assert.ok(!t.includes('EAAB123secret'), 'access_token redacted');
  assert.match(t, /access_token=<REDACTED>/);
  assert.match(t, /^status 400 code=3 GraphMethodException: /);
  assert.match(t, /… \(fbtrace_id TRACE9\)$/);
  // Not a Graph answer: the plain reason, with the status when there is one.
  assert.equal(graphErrorText(new Error('socket hang up')), 'socket hang up');
  assert.equal(graphErrorText(Object.assign(new Error(''), { code: 'ECONNRESET' })), 'ECONNRESET');
  assert.equal(graphErrorText({ response: { status: 502, data: 'Bad gateway' }, message: 'Request failed with status code 502' }), 'status 502 Request failed with status code 502');
  assert.equal(graphErrorText(null), 'unknown error');
  assert.ok(graphErrorText(new Error('x'.repeat(500))).length <= 200);
});
