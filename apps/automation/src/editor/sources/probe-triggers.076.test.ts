import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorOpsService } from '../api/editor-ops.service';
import { PlaybookSchema } from '../network/playbook';
import { ScheduleService, type ScheduleScope } from '../schedule/schedule.service';
import { makeCard } from '../post/testing/fixtures';
import type { CardSource, EditorCard } from '../card';
import { changedCardSources, changedSeriesFeeds, probeInBackground, SAVE_PROBE_MAX_AGE_MS } from './probe-triggers';

/** Spec 076 FR-004 / A30 / I18: the background probes that a card save and a series bind start. */

const FEED: CardSource = { id: 'news', kind: 'rss', ref: 'https://example.com/feed.xml' };
const PAGE: CardSource = { id: 'blog', kind: 'url', ref: 'https://blog.example.org/posts' };
const LIB: CardSource = { id: 'prompts', kind: 'library', ref: 'prompts' };

test('changedCardSources: new and changed rss / url sources only, matched by id', () => {
  assert.deepEqual(changedCardSources([], [FEED, PAGE, LIB]), [
    { url: FEED.ref, kind: 'rss' }, { url: PAGE.ref, kind: 'url' },
  ], 'a library source is not read from the server');
  assert.deepEqual(changedCardSources([FEED, PAGE], [FEED, PAGE]), [], 'nothing changed');
  assert.deepEqual(changedCardSources([FEED], [{ ...FEED, ref: 'https://example.com/other.xml' }]), [{ url: 'https://example.com/other.xml', kind: 'rss' }], 'the same id, another address');
  assert.deepEqual(changedCardSources([FEED], [{ ...FEED, kind: 'url' }]), [{ url: FEED.ref, kind: 'url' }], 'the same address read as another kind');
  assert.deepEqual(changedCardSources([FEED], [{ ...FEED, note: 'a note' }]), [], 'a note is not a change');
  assert.deepEqual(changedCardSources(undefined, [FEED]), [{ url: FEED.ref, kind: 'rss' }], 'a new card');
  assert.deepEqual(changedCardSources([FEED], [{ id: 'x', kind: 'rss', ref: FEED.ref }]), [{ url: FEED.ref, kind: 'rss' }], 'a new id is a new source');
  assert.deepEqual(changedCardSources([], [{ id: 'bad', kind: 'rss', ref: 'not a url' }, { id: 'a', kind: 'url', ref: PAGE.ref }, { id: 'b', kind: 'url', ref: PAGE.ref }]), [{ url: PAGE.ref, kind: 'url' }], 'no address, no probe; one probe per address');
});

test('probeInBackground: starts every probe at once, reuses a 24 h row, never forces, never throws', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const logs: string[] = [];
  probeInBackground(async (u, o) => { calls.push([u, o]); throw new Error('network down'); }, [{ url: FEED.ref, kind: 'rss' }, { url: PAGE.ref, kind: 'url' }], (m) => logs.push(m));
  assert.deepEqual(calls, [
    [FEED.ref, { kind: 'rss', maxAgeMs: SAVE_PROBE_MAX_AGE_MS }],
    [PAGE.ref, { kind: 'url', maxAgeMs: SAVE_PROBE_MAX_AGE_MS }],
  ], 'called before probeInBackground returns');
  assert.equal(SAVE_PROBE_MAX_AGE_MS, 24 * 3_600_000);
  assert.ok(calls.every(([, o]) => !('force' in o)), 'no forced probe on write (I18)');
  await new Promise((ok) => setImmediate(ok));
  assert.equal(logs.length, 2);
  assert.match(logs[0], /network down/);
  // A synchronous throw and a missing port are harmless too.
  probeInBackground(() => { throw new Error('sync'); }, [{ url: FEED.ref, kind: 'rss' }], (m) => logs.push(m));
  assert.match(logs.at(-1)!, /sync/);
  probeInBackground(undefined, [{ url: FEED.ref, kind: 'rss' }]);
});

// ── upsertChannel ──────────────────────────────────────────────────────────────────────────────────────────────────

function ops(existing: EditorCard | null, probe?: (u: string, o: any) => Promise<unknown>) {
  const saved: EditorCard[] = [];
  const svc = new EditorOpsService({
    channels: {
      get: async () => (existing ? { ...existing, createdAt: new Date() } : null),
      list: async () => [],
      upsert: async (c: EditorCard) => { saved.push(c); return { card: { ...c, createdAt: new Date() }, previousMode: existing?.mode ?? null }; },
    },
    skills: { list: () => [] }, registry: { get: () => undefined, all: () => [] },
    ...(probe ? { probe } : {}),
  } as any);
  return { svc, saved };
}

test('upsertChannel probes the new and changed sources, in the background, and the response does not wait', async () => {
  const calls: Array<[string, any]> = [];
  // A probe that never finishes: the save must still return.
  const { svc, saved } = ops(makeCard({ sources: [FEED] }), (u, o) => { calls.push([u, o]); return new Promise(() => {}); });
  const res: any = await svc.upsertChannel('@chan', { sources: [FEED, PAGE, LIB] });
  assert.equal(saved.length, 1);
  assert.equal(res.card.sources.length, 3);
  assert.deepEqual(calls, [[PAGE.ref, { kind: 'url', maxAgeMs: SAVE_PROBE_MAX_AGE_MS }]], 'only the source that is new');
});

test('a save that leaves the sources unchanged (a mode-only save) probes nothing', async () => {
  const calls: string[] = [];
  const { svc } = ops(makeCard({ sources: [FEED, PAGE] }), async (u) => { calls.push(u); });
  await svc.upsertChannel('@chan', { mode: 'approve' });
  await svc.upsertChannel('@chan', { sources: [FEED, PAGE], brief: 'A new brief for the channel' });
  assert.deepEqual(calls, []);
});

test('a new card probes every feed and page source; a service built without the port saves as before', async () => {
  const calls: string[] = [];
  const { svc } = ops(null, async (u) => { calls.push(u); });
  await svc.upsertChannel('@fresh', { sources: [FEED, PAGE, LIB] });
  assert.deepEqual(calls, [FEED.ref, PAGE.ref]);
  const plain = ops(makeCard({ sources: [] }));
  const res: any = await plain.svc.upsertChannel('@chan', { sources: [FEED] });
  assert.equal(res.card.sources.length, 1);
});

// ── commitSeriesChange ─────────────────────────────────────────────────────────────────────────────────────────────

const TG = 'telegram:@news_ch';
const BODY = () => PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 4 } }],
  series: [
    { name: 'Morning news', cadence: 'daily@08:00', resource_ref: TG, format: 'text', brief: 'The morning news from the feed', source: { kind: 'feed', ref: FEED.ref } },
    { name: 'Prompt of the day', cadence: 'daily@19:00', resource_ref: TG, format: 'text', brief: 'A prompt from the library each evening', source: { kind: 'library', table: 'prompts' } },
  ],
});

function schedule(probe?: (u: string, o: any) => Promise<unknown>) {
  const svc = new ScheduleService({
    sourceCatalog: async () => ({ tables: ['prompts'], feeds: [FEED.ref, PAGE.ref] }),
    network: { insertPlaybook: async () => ({ version: 4 }) },
    ...(probe ? { probe } : {}),
  } as any);
  const sc = {
    agent: { id: 'a1', handle: 'news_ch', kind: 'orchestrator', parentId: null },
    card: { channelKey: '@news_ch', sources: [FEED, PAGE] },
    net: { playbook: BODY(), playbookVersion: 3, resources: [{ ref: TG, platform: 'telegram' }], telegramFormats: ['text'] },
  } as unknown as ScheduleScope;
  return { svc, sc };
}

test('changedSeriesFeeds: a feed series that is new or reads another address; a library series and an unchanged one are not', () => {
  const before = BODY();
  assert.deepEqual(changedSeriesFeeds(before, before, [FEED]), []);
  assert.deepEqual(changedSeriesFeeds(null, before, [FEED]), [{ url: FEED.ref, kind: 'rss' }], 'no playbook before: every feed series is new');
  const moved = { ...before, series: before.series.map((s) => (s.name === 'Morning news' ? { ...s, source: { kind: 'feed', ref: PAGE.ref } } : s)) };
  assert.deepEqual(changedSeriesFeeds(before, moved, [FEED, PAGE]), [{ url: PAGE.ref, kind: 'url' }]);
  const byId = { ...before, series: before.series.map((s) => (s.name === 'Morning news' ? { ...s, source: { kind: 'feed', ref: 'blog' } } : s)) };
  assert.deepEqual(changedSeriesFeeds(before, byId, [FEED, PAGE]), [{ url: PAGE.ref, kind: 'url' }], 'a ref that is not an address names a card source (by id)');
  const unknown = { ...before, series: before.series.map((s) => (s.name === 'Morning news' ? { ...s, source: { kind: 'feed', ref: 'no-such-source' } } : s)) };
  assert.deepEqual(changedSeriesFeeds(before, unknown, [FEED, PAGE]), [], 'a ref that names nothing is skipped');
});

test('commitSeriesChange probes a new or changed feed series once saved, and nothing for a brief-only or library change', async () => {
  const calls: Array<[string, any]> = [];
  const { svc, sc } = schedule(async (u, o) => { calls.push([u, o]); });

  const added: any = await svc.commitSeriesChange(sc, 'add', {
    name: 'Blog digest', cadence: 'daily@12:00', resource_ref: TG, format: 'text', brief: 'A digest of the blog every noon', source: { kind: 'feed', ref: PAGE.ref },
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual(calls, [[PAGE.ref, { kind: 'url', maxAgeMs: SAVE_PROBE_MAX_AGE_MS }]], 'the new feed series is read');

  calls.length = 0;
  const brief: any = await svc.commitSeriesChange(sc, 'update', { name: 'Blog digest', brief: 'The digest of the blog, shorter', source: { kind: 'feed', ref: PAGE.ref } });
  assert.equal(brief.ok, true, JSON.stringify(brief));
  assert.deepEqual(calls, [], 'the same address: nothing to read');

  const lib: any = await svc.commitSeriesChange(sc, 'update', { name: 'Prompt of the day', brief: 'A prompt from the library, one a day', source: { kind: 'library', table: 'prompts' } });
  assert.equal(lib.ok, true, JSON.stringify(lib));
  assert.deepEqual(calls, []);

  const moved: any = await svc.commitSeriesChange(sc, 'update', { name: 'Blog digest', source: { kind: 'feed', ref: FEED.ref } });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual(calls, [[FEED.ref, { kind: 'rss', maxAgeMs: SAVE_PROBE_MAX_AGE_MS }]], 'compared with the playbook as it was before this change');
});

test('a series change with no probe port, or one refused by validation, probes nothing', async () => {
  const calls: string[] = [];
  const { svc, sc } = schedule(async (u) => { calls.push(u); });
  const bad: any = await svc.commitSeriesChange(sc, 'add', {
    name: 'Ghost feed', cadence: 'daily@12:00', resource_ref: TG, format: 'text', brief: 'A feed the card does not list', source: { kind: 'feed', ref: 'https://nowhere.example.net/feed.xml' },
  });
  assert.ok(bad.error, 'the card lists no such feed');
  assert.deepEqual(calls, []);
  const plain = schedule();
  const ok: any = await plain.svc.commitSeriesChange(plain.sc, 'add', {
    name: 'Blog digest', cadence: 'daily@12:00', resource_ref: TG, format: 'text', brief: 'A digest of the blog every noon', source: { kind: 'feed', ref: PAGE.ref },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});
