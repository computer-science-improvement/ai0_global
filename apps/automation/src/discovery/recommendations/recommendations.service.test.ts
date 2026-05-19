import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity, scoreCandidate } from './recommendations.service';

test('jaccardSimilarity: returns 0 when either side is empty', () => {
  assert.equal(jaccardSimilarity([], ['a']), 0);
  assert.equal(jaccardSimilarity(['a'], []), 0);
  assert.equal(jaccardSimilarity([], []), 0);
});

test('jaccardSimilarity: returns 1 for identical sets', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarity(['b', 'a'], ['a', 'b']), 1);
});

test('jaccardSimilarity: returns 0 for disjoint sets', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
});

test('jaccardSimilarity: returns 1/3 for half overlap', () => {
  // |∩|=1, |∪|=3 → 1/3
  const v = jaccardSimilarity(['a', 'b'], ['a', 'c']);
  assert.ok(Math.abs(v - 1 / 3) < 1e-9, `expected ≈ 0.333, got ${v}`);
});

test('jaccardSimilarity: deduplicates within each set before computing', () => {
  assert.equal(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b']), 1);
});

test('jaccardSimilarity: is case-sensitive', () => {
  assert.equal(jaccardSimilarity(['A'], ['a']), 0);
});

test('scoreCandidate: returns the Jaccard score', () => {
  const v = scoreCandidate(
    { themes: ['a', 'b'] },
    { themes: ['a', 'c'] },
  );
  assert.ok(Math.abs(v - 1 / 3) < 1e-9, `expected ≈ 0.333, got ${v}`);
});

test('scoreCandidate: returns 0 when candidate themes empty', () => {
  assert.equal(
    scoreCandidate({ themes: ['a'] }, { themes: [] }),
    0,
  );
});

test('scoreCandidate: handles missing themes property defensively', () => {
  assert.equal(scoreCandidate({}, { themes: ['a'] }), 0);
  assert.equal(scoreCandidate({ themes: ['a'] }, {}), 0);
});

// ─── Recommendations pipeline ─────────────────────────────────────────────
import { RecommendationsService } from './recommendations.service';
import type { CandidateChannelsRepository } from '../repositories/candidate-channels.repository';
import type { ChannelThemesRepository } from '../repositories/channel-themes.repository';

interface FakeRepos {
  candidates: Pick<CandidateChannelsRepository, 'candidatesForBudgetAndThemes'>;
  themes:     Pick<ChannelThemesRepository, 'getThemes' | 'listMyUsernames'>;
}

function makeRepos(opts: {
  targetThemes:    string[] | null;
  myUsernames?:    string[];
  rows?:           any[];
}): FakeRepos {
  return {
    candidates: {
      candidatesForBudgetAndThemes: async () => opts.rows ?? [],
    },
    themes: {
      getThemes:        async () => opts.targetThemes,
      listMyUsernames:  async () => opts.myUsernames ?? [],
    },
  };
}

const C = (
  id: string,
  slug: string,
  themes: string[],
  price: number,
  roi: number | null = null,
) => ({
  id, source: 'teleads', external_id: id, slug, link: `https://t.me/${slug}`,
  title: slug, description: null, language: null, themes,
  sex_ratio: null, price_min: price, price_max: price, avatar_url: null,
  estimated_subs_per_ad: roi,
  roi_confidence: roi ? 'medium' : null,
});

test('RecommendationsService: returns warning when target has no themes', async () => {
  const r = makeRepos({ targetThemes: [] });
  const svc = new RecommendationsService(r.candidates as any, r.themes as any);
  const res = await svc.recommend({ targetChannelId: 'x', budget: 100_000 });
  assert.equal(res.recommendations.length, 0);
  assert.match(res.warning ?? '', /themes/i);
});

test('RecommendationsService: throws 404 when target not found', async () => {
  const r = makeRepos({ targetThemes: null });
  const svc = new RecommendationsService(r.candidates as any, r.themes as any);
  await assert.rejects(
    svc.recommend({ targetChannelId: 'missing', budget: 100 }),
    /not found/i,
  );
});

test('RecommendationsService: ranks by score desc, then ROI desc, then price asc', async () => {
  const r = makeRepos({
    targetThemes: ['a', 'b'],
    rows: [
      C('1', 'low_score',   ['a'],         50),
      C('2', 'tied_no_roi', ['a', 'b'],    200),
      C('3', 'tied_roi',    ['a', 'b'],    300, 42),
      C('4', 'tied_cheap',  ['a', 'b'],    100),
    ],
  });
  const svc = new RecommendationsService(r.candidates as any, r.themes as any);
  const res = await svc.recommend({ targetChannelId: 'x', budget: 1_000_000 });

  assert.deepEqual(
    res.recommendations.map(x => x.slug),
    ['tied_roi', 'tied_cheap', 'tied_no_roi', 'low_score'],
  );
});

test('RecommendationsService: applies limit', async () => {
  const r = makeRepos({
    targetThemes: ['a'],
    rows: [
      C('1', 'a', ['a'], 10),
      C('2', 'b', ['a'], 20),
      C('3', 'c', ['a'], 30),
    ],
  });
  const svc = new RecommendationsService(r.candidates as any, r.themes as any);
  const res = await svc.recommend({ targetChannelId: 'x', budget: 1000, limit: 2 });
  assert.equal(res.recommendations.length, 2);
});

test('RecommendationsService: exposes matched themes', async () => {
  const r = makeRepos({
    targetThemes: ['a', 'b'],
    rows: [ C('1', 'x', ['a', 'b', 'c'], 100) ],
  });
  const svc = new RecommendationsService(r.candidates as any, r.themes as any);
  const res = await svc.recommend({ targetChannelId: 'x', budget: 1000 });
  assert.deepEqual(res.recommendations[0].matchedThemes, ['a', 'b']);
});
