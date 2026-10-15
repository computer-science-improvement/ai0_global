import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatsSummary, MarkedMetric, markSampleConfidence, performanceEvidenceCheck, sampleConfidence, weightChangeIssue,
} from './kpi-confidence';

test('sampleConfidence: n = 3 with 2 views → insufficient; n = 10 with median 50 → ok; boundaries', () => {
  assert.equal(sampleConfidence(3, 2), 'insufficient');
  assert.equal(sampleConfidence(10, 50), 'ok');
  assert.equal(sampleConfidence(2, 500), 'insufficient', 'n < 3');
  assert.equal(sampleConfidence(0, null), 'insufficient');
  assert.equal(sampleConfidence(12, null), 'insufficient', 'no views measured');
  assert.equal(sampleConfidence(12, 9.9), 'insufficient', 'median < 10');
  assert.equal(sampleConfidence(3, 10), 'low');
  assert.equal(sampleConfidence(7, 1000), 'low', 'n < 8');
  assert.equal(sampleConfidence(8, 29), 'low', 'median < 30');
  assert.equal(sampleConfidence(8, 30), 'ok');
});

test('formatsSummary: insufficient_data only when every format is insufficient (or there are none)', () => {
  assert.deepEqual(formatsSummary([{ confidence: 'insufficient' }, { confidence: 'insufficient' }]),
    { summary: 'insufficient_data', note: 'not enough data to compare formats' });
  assert.deepEqual(formatsSummary([]), { summary: 'insufficient_data', note: 'not enough data to compare formats' });
  assert.equal(formatsSummary([{ confidence: 'insufficient' }, { confidence: 'low' }]), null);
});

test('weightChangeIssue: refuses with the numbers when a changed format is insufficient; unknown format counts as n = 0', () => {
  const samples = [
    { format: 'album', n: 3, median_views: 2, confidence: 'insufficient' as const },
    { format: 'photo', n: 10, median_views: 50, confidence: 'ok' as const },
  ];
  const r = weightChangeIssue([{ format: 'album', from: 0.5, to: 0.7 }, { format: 'photo', from: 1, to: 0.8 }], samples)!;
  assert.equal(r.error, 'insufficient_data');
  assert.deepEqual(r.details, [{ format: 'album', n: 3, median_views: 2, confidence: 'insufficient' }]);
  assert.equal(weightChangeIssue([{ format: 'photo', from: 1, to: 0.8 }], samples), null);
  assert.deepEqual(weightChangeIssue([{ format: 'poll', from: 0.3, to: 0.5 }], samples)!.details,
    [{ format: 'poll', n: 0, median_views: null, confidence: 'insufficient' }]);
});

test('performanceEvidenceCheck: needs { n, metric, median_views }; refuses insufficient; low and ok pass', () => {
  assert.equal((performanceEvidenceCheck(undefined) as any).error, 'evidence_required');
  assert.equal((performanceEvidenceCheck({ n: 3 }) as any).error, 'evidence_required');
  assert.equal((performanceEvidenceCheck({ n: 3.5, metric: 'views', median_views: 40 }) as any).error, 'evidence_required');
  const bad: any = performanceEvidenceCheck({ n: 3, metric: 'median_views', median_views: 2 });
  assert.equal(bad.error, 'insufficient_data');
  assert.deepEqual(bad.details, { n: 3, metric: 'median_views', median_views: 2, confidence: 'insufficient' });
  assert.deepEqual(performanceEvidenceCheck({ n: 10, metric: 'median_views', median_views: 50 }), { confidence: 'ok', n: 10, median_views: 50 });
  assert.equal((performanceEvidenceCheck({ n: 5, metric: 'median_views', median_views: 20 }) as any).confidence, 'low');
});

test('markSampleConfidence: the digest marks views/engagement of a small 7-day sample, leaves ok samples alone', () => {
  const k: Record<string, MarkedMetric & Record<string, unknown>> = {
    views_per_post: { v: 25, base: 40, d: -37.5, z: -1 },
    engagement_rate: { v: 3.1, base: 2.9, d: 6.9, z: 0.2 },
    posts: { v: 3, base: 7, d: -57, z: null },
    revenue: { v: null, base: null, d: null, z: null },
  };
  const low = markSampleConfidence(k, 3, 25);
  assert.deepEqual(low.views_per_post, { v: 25, base: 40, d: -37.5, z: -1, n: 3, conf: 'low', sample: '(n=3, low confidence)' });
  assert.equal(low.engagement_rate.sample, '(n=3, low confidence)');
  assert.deepEqual(low.posts, k.posts, 'counts are not samples');
  assert.deepEqual(low.revenue, k.revenue);
  assert.equal(markSampleConfidence(k, 2, 2).views_per_post.sample, '(n=2, insufficient data)');
  assert.equal(markSampleConfidence(k, 10, 50), k, 'ok sample: unchanged');
  assert.equal(markSampleConfidence<Record<string, MarkedMetric>>({ views_per_post: { v: null } }, 0, null).views_per_post.sample, undefined, 'no value — nothing to mark');
});
