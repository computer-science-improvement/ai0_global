import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitingLine, deltaTone, fmtKpi, healthyToggleLabel, issueCount, kpiTitle, sortByIssues, summarize, visibleResources,
} from './digest-view';
import type { DigestResource, KpiDigest } from '../api/manager';
import type { ResourceQuality } from './quality-view';

const quality = (flags: ResourceQuality['flags']): ResourceQuality => ({
  days: 7, posts: 3,
  critic: { pass: 3, revise: 0, reject: 0, failed: 0, total: 3, revised_then_passed: 0, pass_rate: 1, mean: null, notes: [] },
  polls: { count: 0, slots: 3, share: 0, cap: null, over: false },
  reader_questions: { cap: 1, with_questions: 0, over_cap: 0, examples: [] },
  owner: { approved: 0, edited: 0, rejected: 0, rejection_rate: null, reasons: [], edits: [] },
  samples: [], flags,
});

const R = (ref: string, anomalies: string[] = [], flags: ResourceQuality['flags'] | null = null): DigestResource => ({
  ref, title: null, agent: null, health: 'ok', kpis: {}, anomalies, quality: flags ? quality(flags) : undefined,
});

test('issue count adds anomalies and quality flags', () => {
  assert.equal(issueCount(R('a')), 0);
  assert.equal(issueCount(R('a', ['views_per_post'])), 1);
  assert.equal(issueCount(R('a', ['views_per_post'], ['critic_reject', 'owner_edits'])), 3);
  assert.equal(issueCount({ anomalies: [], quality: null }), 0);
});

test('flagged resources come first, most flagged first, ties keep the digest order', () => {
  const rs = [R('calm1'), R('one', ['posts']), R('calm2'), R('three', ['posts'], ['critic_reject', 'owner_edits']), R('one-b', [], ['dark_day'])];
  assert.deepEqual(sortByIssues(rs).map((r) => r.ref), ['three', 'one', 'one-b', 'calm1', 'calm2']);
  assert.deepEqual(rs.map((r) => r.ref), ['calm1', 'one', 'calm2', 'three', 'one-b'], 'the input is not reordered');
  assert.deepEqual(sortByIssues([]), []);
});

test('a phone shows the flagged ones until the healthy toggle is opened', () => {
  const sorted = sortByIssues([R('calm'), R('bad', ['posts'])]);
  assert.deepEqual(visibleResources(sorted, true, false).map((r) => r.ref), ['bad']);
  assert.deepEqual(visibleResources(sorted, true, true).map((r) => r.ref), ['bad', 'calm']);
  assert.deepEqual(visibleResources(sorted, false, false).map((r) => r.ref), ['bad', 'calm']);
  assert.deepEqual(visibleResources(sortByIssues([R('calm')]), true, false), []);
});

test('the summary counts flagged and healthy resources, anomalies, quality flags and directives waiting for the owner', () => {
  const dg: Pick<KpiDigest, 'resources' | 'directives' | 'budget'> = {
    resources: [R('a', ['posts', 'revenue']), R('b', [], ['critic_reject']), R('c')],
    directives: {
      open: [
        { id: '1', to: 'x', kind: 'advice', status: 'awaiting_owner', body: '', createdAt: '' },
        { id: '2', to: 'x', kind: 'advice', status: 'contested', body: '', createdAt: '' },
        { id: '3', to: 'x', kind: 'advice', status: 'delivered', body: '', createdAt: '' },
      ],
      outcomes: [],
    },
    budget: { spentTodayUsd: 1.5, capUsd: 5 },
  };
  assert.deepEqual(summarize(dg), {
    resources: 3, flagged: 2, healthy: 1, anomalies: 2, qualityFlagged: 1, open: 3, awaiting: 2, spentTodayUsd: 1.5,
  });
  const empty = summarize({ resources: [], directives: { open: [], outcomes: [] }, budget: { spentTodayUsd: 0, capUsd: 0 } });
  assert.deepEqual([empty.resources, empty.flagged, empty.healthy, empty.awaiting], [0, 0, 0, 0]);
});

test('texts: the awaiting line and the healthy toggle', () => {
  assert.equal(awaitingLine(1), '1 awaits you');
  assert.equal(awaitingLine(2), '2 await you');
  assert.equal(awaitingLine(0), 'none wait for you');
  assert.equal(healthyToggleLabel(1, false), '1 healthy resource');
  assert.equal(healthyToggleLabel(4, false), '4 healthy resources');
  assert.equal(healthyToggleLabel(4, true), 'Show only flagged');
});

test('KPI values: compact thousands, signed growth, percent and hryvnia', () => {
  assert.equal(fmtKpi('views_per_post', null), '—');
  assert.equal(fmtKpi('views_per_post', Number.NaN), '—');
  assert.equal(fmtKpi('views_per_post', 842), '842');
  assert.equal(fmtKpi('views_per_post', 12_345), '12.3K');
  assert.equal(fmtKpi('views_per_post', 123_456), '123K');
  assert.equal(fmtKpi('posts', 4.25), '4.3');
  assert.equal(fmtKpi('engagement_rate', 3.456), '3.46%');
  assert.equal(fmtKpi('engagement_rate', 12.34), '12.3%');
  assert.equal(fmtKpi('followers_growth', 120), '+120');
  assert.equal(fmtKpi('followers_growth', -40), '−40');
  assert.equal(fmtKpi('followers_growth', 0), '0');
  assert.equal(fmtKpi('revenue', 1500), '₴1,500');
});

test('the change against the baseline: up, down, or flat when stale, missing or zero', () => {
  assert.equal(deltaTone({ d: 12 }), 'up');
  assert.equal(deltaTone({ d: -3 }), 'down');
  assert.equal(deltaTone({ d: 0 }), 'flat');
  assert.equal(deltaTone({ d: null }), 'flat');
  assert.equal(deltaTone({ d: 40, stale: true }), 'flat');
  assert.equal(deltaTone(undefined), 'flat');
});

test('the KPI tooltip names the baseline, the z-score and the flags', () => {
  assert.equal(kpiTitle('posts', 'posts', undefined), 'posts: no data');
  assert.equal(
    kpiTitle('engagement_rate', 'engagement', { v: 4.2, base: 3.1, d: 35, z: 2.4, anomaly: true }),
    'engagement: 7-day 4.20% · 28-day baseline 3.10% · z 2.4 · anomaly',
  );
  assert.match(kpiTitle('posts', 'posts', { v: 3, base: null, d: null, z: null, stale: true }), /baseline — · stale \(no fresh data\)$/);
});
