import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaInsightBackoff, METRIC_BACKOFF_MS, isMetricUnsupported } from './meta-insight-backoff';

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
