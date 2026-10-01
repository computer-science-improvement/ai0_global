import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_DEFAULTS, CardPatchSchema, mergeCard } from './card-input';
import { makeCard } from '../post/testing/fixtures';

const issues = (r: ReturnType<typeof mergeCard>) => (r.ok ? [] : r.issues.map((i) => i.path.join('.')));

test('new card: a partial body is filled with the DB defaults', () => {
  const r = mergeCard('@new', null, { mode: 'shadow', brief: 'Про космос' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.card.channelKey, '@new');
  assert.equal(r.card.mode, 'shadow');
  assert.equal(r.card.postsPerDayMin, CARD_DEFAULTS.postsPerDayMin);
  assert.deepEqual(r.card.formats, { text: 1, photo: 1 });
  assert.equal(r.card.timezone, 'Europe/Kyiv');
});

test('existing card: patch only changes the given fields', () => {
  const r = mergeCard('@chan', makeCard(), { mode: 'live' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.card.mode, 'live');
  assert.equal(r.card.brief, 'Канал про космос');
  assert.equal(r.card.channelKey, '@chan');
});

test('mirrors editor_channels constraints', () => {
  const bad = mergeCard('@chan', makeCard(), {
    postsPerDayMin: 7, postsPerDayMax: 3,         // min > max
    quietStartHour: 24,                           // 0..23
    planHour: -1,
    explore_ratio: 0.5,                           // unknown (snake_case) key
  } as any);
  assert.equal(bad.ok, false);
  const p = issues(bad);
  assert.ok(p.includes('quietStartHour'));
  assert.ok(p.includes('planHour'));
  assert.ok(p.some((x) => x === '' || x === 'explore_ratio'), `unknown key rejected: ${p}`);

  const cross = mergeCard('@chan', makeCard(), { postsPerDayMin: 7, postsPerDayMax: 3, hashtagMin: 4, hashtagMax: 2 });
  assert.deepEqual(issues(cross).sort(), ['hashtagMin', 'postsPerDayMin']);
});

test('rejects bad mode, timezone, formats, hashtags, sources and budget', () => {
  const r = mergeCard('@chan', makeCard(), {
    mode: 'on' as any,
    timezone: 'Mars/Olympus',
    formats: { story: 1 } as any,
    hashtags: ['#космос'],
    sources: [{ id: 'x', kind: 'rss', ref: 'ftp://feed' }],
    dailyBudgetUsd: -1,
    exploreRatio: 1.5,
  });
  const p = issues(r);
  for (const k of ['mode', 'timezone', 'formats.story', 'hashtags.0', 'sources.0.ref', 'dailyBudgetUsd', 'exploreRatio']) {
    assert.ok(p.includes(k), `expected issue at ${k}, got ${p.join(',')}`);
  }
});

test('formats must not be empty; library sources take a table name', () => {
  assert.ok(issues(mergeCard('@chan', makeCard(), { formats: {} })).includes('formats'));
  const ok = mergeCard('@chan', makeCard(), { sources: [{ id: 'lib', kind: 'library', ref: 'facts' }] });
  assert.equal(ok.ok, true);
});

test('api sources take a fetch_api source name', () => {
  assert.equal(mergeCard('@chan', makeCard(), { sources: [{ id: 'apod', kind: 'api', ref: 'nasa_apod' }] }).ok, true);
  assert.ok(issues(mergeCard('@chan', makeCard(), { sources: [{ id: 'x', kind: 'api', ref: 'https://api.nasa.gov' }] })).includes('sources.0.ref'));
});

test('nullable fields accept null and explore ratio is rounded to 2 decimals', () => {
  const r = mergeCard('@chan', makeCard({ dailyBudgetUsd: 1, footer: 'x', toolsAllow: ['web_fetch'] }), {
    dailyBudgetUsd: null, footer: null, toolsAllow: null, title: null, exploreRatio: 0.333,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.card.dailyBudgetUsd, null);
  assert.equal(r.card.toolsAllow, null);
  assert.equal(r.card.exploreRatio, 0.33);
});

test('patch schema is strict and every field optional', () => {
  assert.equal(CardPatchSchema.safeParse({}).success, true);
  assert.equal(CardPatchSchema.safeParse({ channelKey: '@x' }).success, false);
});
