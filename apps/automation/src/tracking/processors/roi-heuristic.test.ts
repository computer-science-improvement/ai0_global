import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRoi } from './roi-heuristic';

test('estimateRoi: high engagement multiplies estimate by 1.5', () => {
  const r = estimateRoi({
    avgViews: 10_000,
    subs: 5_000,
    engagementRate: 0.07,
    daysHistory: 60, postsCount: 100,
    viewToSubRate: 0.02,
  });
  assert.equal(r.estimated_subs_per_ad, 300);
  assert.equal(r.confidence, 'high');
});

test('estimateRoi: low engagement halves estimate', () => {
  const r = estimateRoi({
    avgViews: 10_000, subs: 5_000, engagementRate: 0.005,
    daysHistory: 60, postsCount: 100, viewToSubRate: 0.02,
  });
  assert.equal(r.estimated_subs_per_ad, 100);
});

test('estimateRoi: medium engagement uses neutral multiplier', () => {
  const r = estimateRoi({
    avgViews: 1_000, subs: 500, engagementRate: 0.03,
    daysHistory: 60, postsCount: 100, viewToSubRate: 0.02,
  });
  assert.equal(r.estimated_subs_per_ad, 20);
});

test('estimateRoi: confidence "medium" for 14-29 days history', () => {
  const r = estimateRoi({
    avgViews: 1000, subs: 500, engagementRate: 0.03,
    daysHistory: 20, postsCount: 25, viewToSubRate: 0.02,
  });
  assert.equal(r.confidence, 'medium');
});

test('estimateRoi: confidence "low" for fresh channels', () => {
  const r = estimateRoi({
    avgViews: 1000, subs: 500, engagementRate: 0.03,
    daysHistory: 3, postsCount: 5, viewToSubRate: 0.02,
  });
  assert.equal(r.confidence, 'low');
});

test('estimateRoi: zero views returns zero estimate', () => {
  const r = estimateRoi({
    avgViews: 0, subs: 1000, engagementRate: 0,
    daysHistory: 60, postsCount: 100, viewToSubRate: 0.02,
  });
  assert.equal(r.estimated_subs_per_ad, 0);
});
