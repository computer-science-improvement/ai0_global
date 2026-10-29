import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_TOOL } from '../loadout/loadout.service';
import { applyOverlay, blockOf, deriveFacts, siblingConfig, sourceRefsOf, type BlockRow, type SourceRef } from './facts';
import { deepFreeze, makeFacts, mkDataset, mkPlaybook, mkSeries, REF } from './testing/facts-fixture';

/** Spec 072 FR-002, A16: the pure derived fields and the overlay 077 uses to ask "what would the doctor say if". */

const libSeries = (over: Record<string, unknown> = {}) => mkSeries({ source: { kind: 'library', table: 'tips' }, ...over });

test('a deep-frozen input is not changed by an overlay', () => {
  const f = deepFreeze(makeFacts({ playbook: mkPlaybook([libSeries()]), datasets: [mkDataset()] }));
  const before = JSON.stringify(f);
  const out = applyOverlay(f, {
    card: { toolsAllow: ['fetch_url'], sources: [{ id: 'f1', kind: 'rss', ref: 'https://example.com/rss' }] },
    playbook: { id: 'pb9', version: 9, body: mkPlaybook([libSeries({ name: 'Weekly tip', cadence: 'weekly:mon@10:00' })]) },
    datasets: [{ ...mkDataset({ key: 'extra', id: 'ds2' }), boundBy: [], seriesPerDay: 0 }],
  });
  assert.equal(JSON.stringify(f), before);
  assert.notEqual(out, f);
  assert.equal(out.card.toolsAllow?.[0], 'fetch_url');
});

test('a replaced card changes effectiveTools; the loadout still limits it', () => {
  const f = makeFacts({ card: { toolsAllow: null }, loadoutTools: null });
  assert.equal(f.effectiveTools, null);
  assert.deepEqual(applyOverlay(f, { card: { toolsAllow: ['fetch_url', 'query_data'] } }).effectiveTools, ['fetch_url', 'query_data']);
  const limited = makeFacts({ card: { toolsAllow: ['fetch_url', 'query_data'] }, loadoutTools: ['fetch_url'] });
  assert.deepEqual(limited.effectiveTools, ['fetch_url']);
  assert.deepEqual(applyOverlay(limited, { card: { toolsAllow: ['query_data'] } }).effectiveTools, [NO_TOOL], 'an empty intersection is the NO_TOOL sentinel, never []');
});

test('a replaced playbook gives its series on this resource when series is not given', () => {
  const f = makeFacts({ playbook: mkPlaybook([mkSeries({ name: 'Old series' })]) });
  assert.deepEqual(f.series.map((s) => s.name), ['Old series']);
  const other = mkSeries({ name: 'Other channel', resource_ref: 'telegram:@elsewhere' });
  const out = applyOverlay(f, { playbook: { id: 'pb2', version: 4, body: mkPlaybook([mkSeries({ name: 'New series' }), other]) } });
  assert.deepEqual(out.series.map((s) => s.name), ['New series']);
  assert.equal(out.playbook?.version, 4);
  const given = applyOverlay(f, { playbook: { id: 'pb2', version: 4, body: mkPlaybook([]) }, series: [mkSeries({ name: 'Given' })] });
  assert.deepEqual(given.series.map((s) => s.name), ['Given']);
  const dropped = applyOverlay(f, { playbook: null });
  assert.deepEqual(dropped.series, []);
});

test('an added dataset gets boundBy and seriesPerDay from the card and the active series', () => {
  const f = makeFacts({
    card: { sources: [{ id: 'l1', kind: 'library', ref: 'Tips' }] },
    playbook: mkPlaybook([libSeries({ cadence: 'daily@10:00,18:00' }), libSeries({ name: 'Weekly tip', cadence: 'weekly:mon,thu@09:00' }), libSeries({ name: 'Paused tip', active: false })]),
  });
  assert.equal(f.datasets.length, 0);
  const out = applyOverlay(f, { datasets: [{ ...mkDataset(), boundBy: [], seriesPerDay: 0 }] });
  const d = out.datasets[0];
  assert.deepEqual(d.boundBy, ['card', 'series:Daily tip', 'series:Weekly tip']);
  assert.equal(d.seriesPerDay, 2 + 2 / 7, 'two a day plus two a week; the paused series counts nothing');
  const again = applyOverlay(out, { datasets: [{ ...mkDataset({ rows: 3 }), boundBy: [], seriesPerDay: 0 }] });
  assert.equal(again.datasets.length, 1, 'a dataset of the same key is replaced');
  assert.equal(again.datasets[0].rows, 3);
});

test('a dataset nobody reads is bound by nothing', () => {
  const d = applyOverlay(makeFacts(), { datasets: [{ ...mkDataset(), boundBy: ['card'], seriesPerDay: 9 }] }).datasets[0];
  assert.deepEqual(d.boundBy, []);
  assert.equal(d.seriesPerDay, 0);
});

test('series sources become SourceFacts; free, network_highlights and no source add none (A29)', () => {
  const card = { sources: [{ id: 'feed1', kind: 'rss' as const, ref: 'https://feeds.example.com/a.xml' }, { id: 'u1', kind: 'url' as const, ref: 'https://news.example.org/x' }] };
  const f = makeFacts({
    card,
    playbook: mkPlaybook([
      libSeries(),
      mkSeries({ name: 'Api series', source: { kind: 'api', source: 'tmdb_trending' } }),
      mkSeries({ name: 'Feed series', source: { kind: 'feed', ref: 'feed1' } }),
      mkSeries({ name: 'Free series', source: { kind: 'free' } }),
      mkSeries({ name: 'Highlights', source: { kind: 'network_highlights' } }),
      mkSeries({ name: 'No source' }),
      mkSeries({ name: 'Paused api', active: false, source: { kind: 'api', source: 'nasa_apod' } }),
    ]),
  });
  const by = (origin: string) => f.sources.filter((s) => s.origin === origin);
  assert.deepEqual(f.sources.filter((s) => s.origin === 'card').map((s) => s.kind), ['rss', 'url']);
  assert.deepEqual(by('series:Daily tip').map((s) => s.url), ['library:tips']);
  assert.deepEqual(by('series:Api series').map((s) => s.url), ['api:tmdb_trending']);
  assert.deepEqual(by('series:Feed series').map((s) => [s.kind, s.url, s.host]), [['rss', 'https://feeds.example.com/a.xml', 'feeds.example.com']]);
  for (const n of ['Free series', 'Highlights', 'No source', 'Paused api']) assert.equal(by(`series:${n}`).length, 0, n);
});

test('required: a series source follows source_mode; the only card source is required', () => {
  const f = makeFacts({
    card: { sources: [{ id: 'f1', kind: 'rss', ref: 'https://feeds.example.com/a.xml' }] },
    playbook: mkPlaybook([libSeries({ source_mode: 'required' }), mkSeries({ name: 'Suggested api', source: { kind: 'api', source: 'tmdb_trending' } })]),
  });
  const req = (origin: string) => f.sources.find((s) => s.origin === origin)?.required;
  assert.equal(req('card'), true);
  assert.equal(req('series:Daily tip'), true);
  assert.equal(req('series:Suggested api'), false);
  const two = applyOverlay(f, { card: { sources: [{ id: 'f1', kind: 'rss', ref: 'https://feeds.example.com/a.xml' }, { id: 'f2', kind: 'rss', ref: 'https://feeds.example.com/b.xml' }] } });
  assert.equal(two.sources.find((s) => s.url.endsWith('a.xml') && s.origin === 'card')?.required, false);
});

test('an overlay card with new sources rebuilds the source facts and keeps a known host block', () => {
  const block = { reason: 'refused', until: '2030-01-01T00:00:00.000Z', strikes: 2 };
  const f = makeFacts({
    card: { sources: [{ id: 'f1', kind: 'rss', ref: 'https://feeds.example.com/a.xml' }] },
    sources: [{ url: 'https://feeds.example.com/a.xml', kind: 'rss', origin: 'card', host: 'feeds.example.com', hostBlock: block, lastSuccessAt: null }],
  });
  const out = applyOverlay(f, { card: { sources: [{ id: 'f1', kind: 'rss', ref: 'https://feeds.example.com/a.xml' }, { id: 'f2', kind: 'rss', ref: 'https://feeds.example.com/b.xml' }] } });
  assert.equal(out.sources.length, 2);
  assert.deepEqual(out.sources[0].hostBlock, block);
  assert.deepEqual(out.sources[1].hostBlock, block, 'the host of a new feed is blocked as well');
  const none = applyOverlay(f, { card: { sources: [] } });
  assert.equal(none.sources.length, 0);
});

test('overlay sources are added and survive a later overlay of the card', () => {
  const f = makeFacts();
  const added = applyOverlay(f, { sources: [{ url: 'https://probe.example.com/feed', kind: 'rss', origin: 'card', host: 'probe.example.com', hostBlock: null }] });
  assert.equal(added.sources.length, 1);
  assert.equal(added.sources[0].required, true, 'a lone card source is required');
});

test('conflictInput is rebuilt from the card, the profile and the siblings', () => {
  const f = makeFacts({ card: { hashtagMin: 2, hashtags: ['a'] }, conflictBase: { rules: [{ id: 5, text: 'No hashtags' }], refs: [REF, 'telegram:@sib'], others: [siblingConfig('telegram:@sib', null)] } });
  assert.deepEqual(f.conflictInput.resources.map((r) => r.ref), [REF, 'telegram:@sib']);
  assert.equal(f.conflictInput.resources[0].hashtagMin, 2);
  assert.deepEqual(f.conflictInput.rules, [{ id: 5, text: 'No hashtags' }]);
  const out = applyOverlay(f, { card: { hashtagMin: 0 } });
  assert.equal(out.conflictInput.resources[0].hashtagMin, 0);
  assert.equal(out.conflictInput.playbook, f.playbook?.body);
});

test('deriveFacts takes series as given and otherwise reads the playbook', () => {
  const f = makeFacts({ playbook: mkPlaybook([mkSeries()]) });
  const { effectiveTools: _e, conflictInput: _c, series: _s, datasets: _d, sources: _src, ...rest } = f;
  const raw = { ...rest, datasets: [], sources: [] };
  assert.equal(deriveFacts(raw).series.length, 1);
  assert.equal(deriveFacts({ ...raw, series: [] }).series.length, 0);
});

test('blockOf: a feed answers to its own key then to the host; each side ignores the other kind of block', () => {
  const row = (host: string, reason: string): BlockRow => ({ host, reason, until: '2030-01-01T00:00:00.000Z', strikes: 1 });
  const rss: SourceRef = { url: 'https://h.example/a.xml', kind: 'rss', origin: 'card', host: 'h.example', feedKey: 'h.example/a.xml' };
  const page: SourceRef = { url: 'https://h.example/p', kind: 'url', origin: 'card', host: 'h.example', feedKey: null };
  const rows = (...r: BlockRow[]) => new Map(r.map((x) => [x.host, x]));
  assert.equal(blockOf(rss, rows()), null);
  assert.equal(blockOf(rss, rows(row('h.example/a.xml', 'feed_gone')))?.reason, 'feed_gone');
  assert.equal(blockOf(rss, rows(row('h.example', 'refused'))), null, 'a fetch_feed ignores the host page refusal');
  assert.equal(blockOf(rss, rows(row('h.example', 'timeout')))?.reason, 'timeout');
  assert.equal(blockOf(page, rows(row('h.example', 'refused')))?.reason, 'refused');
  assert.equal(blockOf(page, rows(row('h.example', 'feed_gone'))), null, 'a page fetch ignores a feed failure');
  assert.equal(blockOf({ ...page, host: null }, rows(row('h.example', 'refused'))), null);
});

test('sourceRefsOf maps card sources by kind', () => {
  const refs = sourceRefsOf({ sources: [
    { id: '1', kind: 'rss', ref: 'https://a.example/f.xml' }, { id: '2', kind: 'url', ref: 'https://b.example/p' },
    { id: '3', kind: 'library', ref: 'tips' }, { id: '4', kind: 'api', ref: 'tmdb_trending' },
  ] }, []);
  assert.deepEqual(refs.map((r) => [r.kind, r.url, r.host]), [
    ['rss', 'https://a.example/f.xml', 'a.example'], ['url', 'https://b.example/p', 'b.example'], ['library', 'library:tips', null], ['api', 'api:tmdb_trending', null],
  ]);
});
