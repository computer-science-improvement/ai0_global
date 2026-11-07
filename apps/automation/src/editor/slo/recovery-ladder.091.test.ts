// Spec 091 FR-004: the recovery ladder — nextRung per cause, tried rungs, the evergreen cap, the specs, and the class over a fake store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { RecoveryLadder, RUNGS_BY_CAUSE, formatRank, lighterFormat, lightestFormat, nextRung, specFor, evergreenReplacement, type LadderFacts, type LadderStore } from './recovery-ladder';
import type { ClosedSlot } from './types';

const NOW = new Date('2026-11-07T09:00:00Z');
const live = { sources: ['feed:a'], brief: 'Свіжі новини про космос', max_age_hours: 6, origin: 'planner' as const };
const closed = (o: Partial<ClosedSlot> = {}): ClosedSlot => ({
  id: 's1', channelKey: '@chan', scheduledAt: NOW, status: 'skipped', error: null, format: 'photo', topic: 'Тема', seriesName: 'Космос',
  topicMode: 'fixed', live: null, sourceHints: [], slo: null, ...o,
});
const facts = (o: Partial<LadderFacts> = {}): LadderFacts => ({
  closed: closed(), formats: { text: 1, photo: 1, poll: 0.3 }, brief: 'Канал про космос',
  otherSeries: [], okSources: [], evergreenToday: 0, evergreenCap: 1, widenMaxHours: 48, ...o,
});
const series = (name: string, unposted: number | null, repeats = false) => ({ name, format: 'text', brief: `Серія ${name} про щось корисне`, dataset: `d_${name}`, unposted, repeats });

test('rungs per cause match the FR-004 table', () => {
  assert.deepEqual(RUNGS_BY_CAUSE.quality, ['next_material', 'lighter_format', 'evergreen']);
  assert.deepEqual(RUNGS_BY_CAUSE.critic, RUNGS_BY_CAUSE.quality);
  assert.deepEqual(RUNGS_BY_CAUSE.no_material, ['widen_live', 'other_series', 'evergreen']);
  assert.deepEqual(RUNGS_BY_CAUSE.source_used, RUNGS_BY_CAUSE.no_material);
  assert.deepEqual(RUNGS_BY_CAUSE.source_unreachable, ['other_source', 'evergreen']);
});

test('quality / critic: next material, then lighter format, then evergreen; tried rungs are skipped', () => {
  const f = facts();
  assert.equal(nextRung('quality', [], f), 'next_material');
  assert.equal(nextRung('critic', ['next_material'], f), 'lighter_format');
  assert.equal(nextRung('quality', ['next_material', 'lighter_format'], f), 'evergreen');
  assert.equal(nextRung('quality', ['next_material', 'lighter_format', 'evergreen'], f), null);
});

test('lighter_format is skipped when the closed slot is already the lightest format of the mix', () => {
  const f = facts({ closed: closed({ format: 'text' }) });
  assert.equal(nextRung('quality', ['next_material'], f), 'evergreen');
});

test('format order: text over poll over image; zero weights are not in the mix', () => {
  assert.ok(formatRank('text') < formatRank('poll') && formatRank('poll') < formatRank('photo') && formatRank('photo') < formatRank('album'));
  assert.equal(lighterFormat({ text: 1, poll: 1, photo: 1 }, 'photo'), 'text');
  assert.equal(lighterFormat({ text: 0, poll: 1, photo: 1 }, 'photo'), 'poll');
  assert.equal(lighterFormat({ photo: 1 }, 'photo'), null);
  assert.equal(lightestFormat({ photo: 1, album: 1 }), 'photo');
  assert.equal(lightestFormat({}), 'text');
});

test('no_material: widen_live only for live slots with room; then another series; then evergreen', () => {
  const liveFacts = facts({ closed: closed({ topicMode: 'live', live }), otherSeries: [series('Інша', 20)] });
  assert.equal(nextRung('no_material', [], liveFacts), 'widen_live');
  assert.equal(nextRung('source_used', ['widen_live'], liveFacts), 'other_series');
  assert.equal(nextRung('no_material', ['widen_live', 'other_series'], liveFacts), 'evergreen');
  // a fixed slot has no live window to widen
  assert.equal(nextRung('no_material', [], facts({ otherSeries: [series('Інша', 5)] })), 'other_series');
  // a live slot already as wide as the setting
  assert.equal(nextRung('no_material', [], facts({ closed: closed({ topicMode: 'live', live: { ...live, max_age_hours: 48 } }) })), 'evergreen');
  // no series with runway
  assert.equal(nextRung('no_material', [], facts()), 'evergreen');
});

test('source_unreachable: another probed source, then evergreen', () => {
  const f = facts({ okSources: [{ id: 'b', kind: 'rss', ref: 'https://b.example/rss' }] });
  assert.equal(nextRung('source_unreachable', [], f), 'other_source');
  assert.equal(nextRung('source_unreachable', ['other_source'], f), 'evergreen');
  assert.equal(nextRung('source_unreachable', [], facts()), 'evergreen');
});

test('evergreen respects the cap: none left means starved (null)', () => {
  assert.equal(nextRung('source_unreachable', [], facts({ evergreenToday: 1, evergreenCap: 1 })), null);
  assert.equal(nextRung('source_unreachable', [], facts({ evergreenToday: 1, evergreenCap: 2 })), 'evergreen');
  assert.equal(nextRung('quality', ['next_material', 'lighter_format'], facts({ evergreenCap: 0 })), null);
});

test('specs: next material keeps the series and live spec; lighter format changes only the format', () => {
  const f = facts({ closed: closed({ topicMode: 'live', live, sourceHints: ['https://x.example'] }) });
  const next = specFor('next_material', f, makeCard())!;
  assert.equal(next.seriesName, 'Космос');
  assert.equal(next.topicMode, 'live');
  assert.deepEqual(next.live, live);
  assert.match(next.angle!, /НАСТУПНИЙ/);
  assert.notEqual(next.live, live, 'the live spec is copied, not shared');
  const light = specFor('lighter_format', f, makeCard())!;
  assert.equal(light.format, 'text');
  assert.equal(light.topic, 'Тема');
});

test('specs: widen_live raises max_age_hours to SLO_WIDEN_MAX_HOURS and keeps the sources', () => {
  const spec = specFor('widen_live', facts({ closed: closed({ topicMode: 'live', live }), widenMaxHours: 36 }), makeCard())!;
  assert.equal(spec.topicMode, 'live');
  assert.equal(spec.live!.max_age_hours, 36);
  assert.deepEqual(spec.live!.sources, ['feed:a']);
  assert.equal(specFor('widen_live', facts(), makeCard()), null);
});

test('specs: other_series takes the series with most runway; repeating datasets first', () => {
  const f = facts({ otherSeries: [series('Мала', 3), series('Велика', 90), series('Цикл', null, true)] });
  assert.equal(specFor('other_series', f, makeCard())!.seriesName, 'Цикл');
  const g = facts({ otherSeries: [series('Мала', 3), series('Велика', 90)] });
  const s = specFor('other_series', g, makeCard())!;
  assert.equal(s.seriesName, 'Велика');
  assert.equal(s.topicMode, 'fixed');
});

test('specs: other_source swaps the live source, or hints the source of a fixed slot', () => {
  const ok = [{ id: 'b', kind: 'rss', ref: 'https://b.example/rss' }];
  const l = specFor('other_source', facts({ okSources: ok, closed: closed({ topicMode: 'live', live }) }), makeCard())!;
  assert.deepEqual(l.live!.sources, ['b']);
  const fx = specFor('other_source', facts({ okSources: ok }), makeCard())!;
  assert.deepEqual(fx.sourceHints, ['https://b.example/rss']);
  assert.equal(fx.topicMode, 'fixed');
});

test('evergreen spec: fixed, no series, no live, no hints, lightest format, asks for story.kind evergreen', () => {
  const s = evergreenReplacement(makeCard({ formats: { photo: 1, poll: 1 }, brief: 'Канал про космос' }));
  assert.equal(s.format, 'poll');
  assert.equal(s.topicMode, 'fixed');
  assert.equal(s.live, null);
  assert.equal(s.seriesName, null);
  assert.deepEqual(s.sourceHints, []);
  assert.match(s.topic, /Вічнозелений пост/);
  assert.match(s.angle!, /kind: "evergreen"/);
});

class FakeStore implements LadderStore {
  calls: string[] = [];
  constructor(private o: { series?: any[]; sources?: any[]; used?: number; dark?: boolean; throwSeries?: boolean } = {}) {}
  async seriesWithRunway() { this.calls.push('series'); if (this.o.throwSeries) throw new Error('boom'); return this.o.series ?? []; }
  async okSources() { this.calls.push('sources'); return this.o.sources ?? []; }
  async evergreenToday() { this.calls.push('evergreen'); return this.o.used ?? 0; }
  async isDark() { return this.o.dark ?? false; }
}
const env = (o: Record<string, string> = {}) => (k: string) => o[k];

test('RecoveryLadder.choose: first free rung, walks the ladder as rungs are tried, null when starved', async () => {
  const ladder = new RecoveryLadder({ store: new FakeStore(), env: env() });
  const card = makeCard();
  const c = closed();
  assert.equal((await ladder.choose(card, c, 'quality', [], NOW))!.rung, 'next_material');
  assert.equal((await ladder.choose(card, c, 'quality', ['next_material'], NOW))!.rung, 'lighter_format');
  assert.equal((await ladder.choose(card, c, 'quality', ['next_material', 'lighter_format'], NOW))!.rung, 'evergreen');
  assert.equal(await ladder.choose(card, c, 'quality', ['next_material', 'lighter_format', 'evergreen'], NOW), null);
});

test('RecoveryLadder: queries only what the cause needs; the closed slot own series and source are left out', async () => {
  const store = new FakeStore({ series: [series('Космос', 50), series('Інша', 10)], sources: [{ id: 'a', kind: 'rss', ref: 'https://a.example/rss' }, { id: 'b', kind: 'rss', ref: 'https://b.example/rss' }] });
  const ladder = new RecoveryLadder({ store, env: env() });
  const q = await ladder.choose(makeCard(), closed(), 'quality', [], NOW);
  assert.equal(q!.rung, 'next_material');
  assert.deepEqual(store.calls, ['evergreen'], 'no series or source query for a quality skip');
  const n = await ladder.choose(makeCard(), closed(), 'no_material', [], NOW);
  assert.equal(n!.rung, 'other_series');
  assert.equal(n!.spec.seriesName, 'Інша');
  const u = await ladder.choose(makeCard(), closed({ topicMode: 'live', live }), 'source_unreachable', [], NOW);
  assert.equal(u!.rung, 'other_source');
  assert.deepEqual(u!.spec.live!.sources, ['b'], 'feed:a (the failing source) is not picked again');
});

test('RecoveryLadder: a store failure is not a crash — the ladder falls through to evergreen', async () => {
  const ladder = new RecoveryLadder({ store: new FakeStore({ throwSeries: true }), env: env(), log: () => {} });
  assert.equal((await ladder.choose(makeCard(), closed(), 'no_material', [], NOW))!.rung, 'evergreen');
});

test('RecoveryLadder: evergreen cap is EDITOR_EVERGREEN_PER_DAY, raised to SLO_EVERGREEN_DARK_MAX while dark', async () => {
  const normal = new RecoveryLadder({ store: new FakeStore({ used: 1 }), env: env() });
  assert.equal(await normal.choose(makeCard(), closed(), 'source_unreachable', [], NOW), null);
  assert.deepEqual(await normal.evergreenRoom(makeCard(), NOW), { used: 1, cap: 1, dark: false });
  const dark = new RecoveryLadder({ store: new FakeStore({ used: 1, dark: true }), env: env() });
  assert.equal((await dark.choose(makeCard(), closed(), 'source_unreachable', [], NOW))!.rung, 'evergreen');
  const darkFull = new RecoveryLadder({ store: new FakeStore({ used: 2, dark: true }), env: env() });
  assert.equal(await darkFull.choose(makeCard(), closed(), 'source_unreachable', [], NOW), null);
  const custom = new RecoveryLadder({ store: new FakeStore({ used: 2, dark: true }), env: env({ SLO_EVERGREEN_DARK_MAX: '3' }) });
  assert.equal((await custom.choose(makeCard(), closed(), 'source_unreachable', [], NOW))!.rung, 'evergreen');
  const off = new RecoveryLadder({ store: new FakeStore({ used: 0 }), env: env({ EDITOR_EVERGREEN_PER_DAY: '0' }) });
  assert.equal(await off.choose(makeCard(), closed(), 'source_unreachable', [], NOW), null, 'evergreen switched off');
});

test('RecoveryLadder: SLO_WIDEN_MAX_HOURS is read live', async () => {
  const c = closed({ topicMode: 'live', live });
  const a = await new RecoveryLadder({ store: new FakeStore(), env: env({ SLO_WIDEN_MAX_HOURS: '30' }) }).choose(makeCard(), c, 'no_material', [], NOW);
  assert.equal(a!.spec.live!.max_age_hours, 30);
  const b = await new RecoveryLadder({ store: new FakeStore(), env: env() }).choose(makeCard(), c, 'no_material', [], NOW);
  assert.equal(b!.spec.live!.max_age_hours, 48);
});
