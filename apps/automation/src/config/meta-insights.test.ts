import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSIGHT_METRICS, mergeInsightValues, parseMetricValues, type MetaInsightDay } from './meta-insights';

test('mapping exposes the normalized metric → platform-metric per platform', () => {
  assert.deepEqual(INSIGHT_METRICS.instagram, { reach: 'reach', impressions: 'impressions', profileViews: 'profile_views' });
  assert.deepEqual(INSIGHT_METRICS.facebook, { reach: 'page_impressions_unique', impressions: 'page_impressions', profileViews: 'page_views_total' });
  assert.deepEqual(INSIGHT_METRICS.threads, { impressions: 'views' });
});

test('mergeInsightValues folds per-metric day series into one row per day', () => {
  const byMetric = {
    reach: [{ day: '2026-06-10', value: 100 }, { day: '2026-06-11', value: 120 }],
    impressions: [{ day: '2026-06-11', value: 300 }],
    profileViews: [{ day: '2026-06-10', value: 5 }],
  };
  const out = mergeInsightValues(byMetric);
  const expected: MetaInsightDay[] = [
    { day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 },
    { day: '2026-06-11', reach: 120, impressions: 300, profileViews: null },
  ];
  assert.deepEqual(out, expected);
});

test('mergeInsightValues sorts by day ascending and tolerates missing metrics', () => {
  const out = mergeInsightValues({ impressions: [{ day: '2026-06-12', value: 9 }, { day: '2026-06-09', value: 4 }] });
  assert.deepEqual(out.map(d => d.day), ['2026-06-09', '2026-06-12']);
  assert.equal(out[0].reach, null);
  assert.equal(out[0].profileViews, null);
});

test('parseMetricValues extracts {day,value} from a Graph metric body', () => {
  const body = { data: [{ name: 'reach', period: 'day', values: [
    { value: 100, end_time: '2026-06-10T07:00:00+0000' },
    { value: 120, end_time: '2026-06-11T07:00:00+0000' },
  ] }] };
  assert.deepEqual(parseMetricValues(body), [{ day: '2026-06-10', value: 100 }, { day: '2026-06-11', value: 120 }]);
});

test('parseMetricValues returns [] for an empty/odd body', () => {
  assert.deepEqual(parseMetricValues({}), []);
  assert.deepEqual(parseMetricValues({ data: [{ values: 'nope' }] }), []);
});
