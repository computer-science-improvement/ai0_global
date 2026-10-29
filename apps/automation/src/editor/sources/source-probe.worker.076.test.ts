import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import type { CardSource, EditorCard } from '../card';
import type { ProbeResult } from './probe';
import {
  dailyProbe, pausedReprobe, PROBE_GAP_MS, REPROBE_SKIP_MS, SourceProbeWorker, sourcesToProbe, YOUNG_CHANNEL_DAYS, type SourceProbeDeps,
} from './source-probe.worker';

/** Spec 076 FR-004 / A3 / A18: the daily probe of young channels, the host notes, and the 6-hourly forced re-probe of paused channels. */

const NOW = new Date('2026-10-29T05:35:00Z');
const DAY = 86_400_000;
const rss = (id: string, ref: string): CardSource => ({ id, kind: 'rss', ref });
const url = (id: string, ref: string): CardSource => ({ id, kind: 'url', ref });
const card = (channelKey: string, sources: CardSource[], ageDays: number, mode: EditorCard['mode'] = 'approve') =>
  ({ ...makeCard({ channelKey, sources, mode }), createdAt: new Date(NOW.getTime() - ageDays * DAY) });

const result = (u: string, cached: boolean): ProbeResult => ({
  ok: true, failure_class: null, status: 200, kind: 'rss', feed_url: u, items: 3, newest_at: null, sample_titles: [], checked_at: NOW.toISOString(),
  via_proxy: false, url: u, detail: '3 items', ms: 20, cached, blocked_until: null,
});

interface Rig {
  deps:   SourceProbeDeps;
  probes: Array<[string, Record<string, unknown>]>;
  sleeps: number[];
  notes:  Array<[string, string | null]>;
  logs:   string[];
}

function rig(o: {
  cards?: Array<EditorCard & { createdAt: Date }>;
  playbooks?: Record<string, unknown>;
  cached?: Set<string>;
  failing?: Set<string>;
  paused?: string[];
  troubled?: string[];
  probedAt?: Record<string, Date>;
  noteHosts?: Record<string, string[]>;
} = {}): Rig {
  const cards = o.cards ?? [];
  const probes: Rig['probes'] = [];
  const sleeps: number[] = [];
  const notes: Rig['notes'] = [];
  const logs: string[] = [];
  const deps: SourceProbeDeps = {
    channels: { listActive: async () => cards.filter((c) => c.mode !== 'off'), get: async (k) => cards.find((c) => c.channelKey === k) ?? null },
    playbookOf: async (ref) => o.playbooks?.[ref] ?? null,
    probe: (async (u: string, opts: any) => {
      probes.push([u, opts]);
      if (o.failing?.has(u)) throw new Error('boom');
      return result(u, !!o.cached?.has(u));
    }) as any,
    probedAt: async (urls) => new Map(urls.filter((u) => o.probedAt?.[u]).map((u) => [u, o.probedAt![u]])),
    troubledKeys: async (keys) => new Set(keys.filter((k) => o.troubled?.includes(k))),
    pausedChannels: async () => o.paused ?? [],
    noteStruck: async (c, agentId) => { notes.push([c.channelKey, agentId]); return o.noteHosts?.[c.channelKey] ?? []; },
    agentIdOf: async (k) => `agent-of-${k}`,
    now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, log: (m) => logs.push(m),
  };
  return { deps, probes, sleeps, notes, logs };
}

test('sourcesToProbe: the card\'s feeds and pages plus the playbook\'s, http only, each address once', () => {
  const c = card('@c', [rss('a', 'https://a.example/feed.xml'), url('b', 'https://b.example/news'), { id: 'lib', kind: 'library', ref: 'prompts' }, rss('dup', 'https://a.example/feed.xml/')], 1);
  const body = { series: [{ name: 'S', active: true, source: { kind: 'feed', ref: 'https://c.example/rss' } }] };
  assert.deepEqual(sourcesToProbe(c, body), [
    { url: 'https://a.example/feed.xml', kind: 'rss' }, { url: 'https://b.example/news', kind: 'url' }, { url: 'https://c.example/rss', kind: 'rss' },
  ]);
  assert.deepEqual(sourcesToProbe(c, null).map((s) => s.url), ['https://a.example/feed.xml', 'https://b.example/news']);
});

test('dailyProbe: young channels are probed cache first and 2 s apart; an old channel is not, but its host notes are written', async () => {
  const young = card('@young', [rss('f', 'https://young.example/feed.xml')], 3);
  const old = card('@old', [rss('f', 'https://old.example/feed.xml')], YOUNG_CHANNEL_DAYS + 1);
  const off = card('@off', [rss('f', 'https://off.example/feed.xml')], 1, 'off');
  const r = rig({
    cards: [young, old, off],
    playbooks: { 'telegram:@young': { series: [{ name: 'News', source: { kind: 'feed', ref: 'https://pb.example/atom.xml' } }] } },
    noteHosts: { '@old': ['old.example'] },
  });
  const out = await dailyProbe(r.deps);
  assert.deepEqual(out.channels, ['@young']);
  assert.deepEqual(r.probes, [
    ['https://young.example/feed.xml', { kind: 'rss' }],
    ['https://pb.example/atom.xml', { kind: 'rss' }],
  ], 'the card\'s source, then the playbook\'s; no `force`: a probe younger than 6 h is reused');
  assert.deepEqual(r.sleeps, [PROBE_GAP_MS, PROBE_GAP_MS]);
  assert.equal(PROBE_GAP_MS, 2000);
  assert.deepEqual(r.notes, [['@young', 'agent-of-@young'], ['@old', 'agent-of-@old']], 'every active card, young or not; an `off` card has none');
  assert.deepEqual(out.noted, ['@old/old.example']);
});

test('dailyProbe: a cached answer needs no pause; one failing source does not stop the rest', async () => {
  const c = card('@young', [rss('a', 'https://a.example/feed.xml'), rss('b', 'https://b.example/feed.xml'), url('c', 'https://c.example/')], 1);
  const r = rig({ cards: [c], cached: new Set(['https://a.example/feed.xml']), failing: new Set(['https://b.example/feed.xml']) });
  const out = await dailyProbe(r.deps);
  assert.deepEqual(out.probed, ['https://a.example/feed.xml', 'https://c.example/']);
  assert.deepEqual(r.sleeps, [PROBE_GAP_MS], 'only the live read is followed by a pause');
  assert.ok(r.logs.some((l) => /b\.example.*boom/.test(l)));
});

test('dailyProbe writes the host notes with SOURCE_PROPOSALS off: that switch only gates the agent\'s replacement proposals', async () => {
  const saved = process.env.SOURCE_PROPOSALS;
  process.env.SOURCE_PROPOSALS = 'off';
  try {
    const r = rig({ cards: [card('@old', [rss('f', 'https://old.example/feed.xml')], 60)], noteHosts: { '@old': ['old.example'] } });
    const out = await dailyProbe(r.deps);
    assert.deepEqual(r.notes, [['@old', 'agent-of-@old']]);
    assert.deepEqual(out.noted, ['@old/old.example']);
    assert.deepEqual(r.probes, [], 'and the old channel is not probed');
  } finally {
    if (saved === undefined) delete process.env.SOURCE_PROPOSALS; else process.env.SOURCE_PROPOSALS = saved;
  }
});

test('dailyProbe: a failing note step of one card does not stop the others', async () => {
  const r = rig({ cards: [card('@a', [], 1), card('@b', [], 1)] });
  r.deps.noteStruck = async (c) => { if (c.channelKey === '@a') throw new Error('inbox down'); r.notes.push([c.channelKey, null]); return ['x.example']; };
  const out = await dailyProbe(r.deps);
  assert.deepEqual(out.noted, ['@b/x.example']);
  assert.ok(r.logs.some((l) => /@a.*inbox down/.test(l)));
});

// ── pausedReprobe ──────────────────────────────────────────────────────────────────────────────────────────────────

test('pausedReprobe: the blocked host of a paused channel is force-probed once, with the source\'s kind', async () => {
  const c = card('@paused', [rss('f1', 'https://slow.example/feed.xml'), url('p1', 'https://slow.example/news'), rss('ok', 'https://fine.example/feed.xml')], 40);
  const r = rig({ cards: [c], paused: ['@paused'], troubled: ['slow.example'] });
  const out = await pausedReprobe(r.deps);
  assert.deepEqual(out.channels, ['@paused']);
  assert.deepEqual(r.probes, [['https://slow.example/feed.xml', { kind: 'rss', force: true }]], 'the first source on the host, forced; the healthy host is left alone');
  assert.deepEqual(r.sleeps, [PROBE_GAP_MS]);
});

test('pausedReprobe: a feed key row counts, and one host is probed once across channels', async () => {
  const a = card('@a', [rss('f', 'https://shared.example/blog/feed.xml')], 40);
  const b = card('@b', [rss('f', 'https://shared.example/other/feed.xml')], 40);
  const r = rig({ cards: [a, b], paused: ['@a', '@b'], troubled: ['shared.example/blog/feed.xml'] });
  const out = await pausedReprobe(r.deps);
  assert.deepEqual(out.probed, ['https://shared.example/blog/feed.xml']);
  assert.deepEqual(r.probes.map(([u]) => u), ['https://shared.example/blog/feed.xml'], 'the second channel\'s source is on the same host: not asked again this run');
});

test('pausedReprobe: an address probed 10 minutes ago is skipped, one probed an hour ago is not', async () => {
  const c = card('@p', [rss('a', 'https://a.example/feed.xml'), rss('b', 'https://b.example/feed.xml')], 40);
  const r = rig({
    cards: [c], paused: ['@p'], troubled: ['a.example', 'b.example'],
    probedAt: { 'https://a.example/feed.xml': new Date(NOW.getTime() - 10 * 60_000), 'https://b.example/feed.xml': new Date(NOW.getTime() - 60 * 60_000) },
  });
  const out = await pausedReprobe(r.deps);
  assert.deepEqual(out.skipped, ['https://a.example/feed.xml']);
  assert.deepEqual(r.probes, [['https://b.example/feed.xml', { kind: 'rss', force: true }]]);
  assert.equal(REPROBE_SKIP_MS, 30 * 60_000);
});

test('pausedReprobe: no paused channel, an unknown channel, or a host with no row means no request', async () => {
  const none = rig({ cards: [card('@p', [rss('a', 'https://a.example/feed.xml')], 40)] });
  assert.deepEqual((await pausedReprobe(none.deps)).channels, []);
  const missing = rig({ paused: ['@gone'] });
  assert.deepEqual((await pausedReprobe(missing.deps)).channels, []);
  const clean = rig({ cards: [card('@p', [rss('a', 'https://a.example/feed.xml')], 40)], paused: ['@p'], troubled: [] });
  const out = await pausedReprobe(clean.deps);
  assert.deepEqual(out.channels, ['@p']);
  assert.deepEqual(clean.probes, []);
});

test('pausedReprobe: a paused channel is probed whatever its age, and a failing probe is logged, not thrown', async () => {
  const ancient = card('@ancient', [rss('a', 'https://a.example/feed.xml')], 900);
  const r = rig({ cards: [ancient], paused: ['@ancient'], troubled: ['a.example'], failing: new Set(['https://a.example/feed.xml']) });
  const out = await pausedReprobe(r.deps);
  assert.deepEqual(out.probed, []);
  assert.ok(r.logs.some((l) => /a\.example.*boom/.test(l)));
});

// ── the Nest worker: gated by EDITOR_ENABLED ───────────────────────────────────────────────────────────────────────

function worker(enabled: string | undefined, queries: string[], fail = false) {
  const pool = { query: async (sql: string) => { queries.push(sql); if (fail) throw new Error('db down'); return { rows: [] }; } } as any;
  const config = { get: (k: string) => (k === 'EDITOR_ENABLED' ? enabled : undefined) } as any;
  return new SourceProbeWorker(pool, config, null);
}

test('both crons return at once unless EDITOR_ENABLED is "true"', async () => {
  for (const flag of [undefined, 'false', '1', '']) {
    const queries: string[] = [];
    const w = worker(flag, queries);
    await w.daily();
    await w.paused();
    assert.deepEqual(queries, [], `EDITOR_ENABLED=${String(flag)}`);
  }
  const queries: string[] = [];
  const w = worker('true', queries);
  await w.daily();
  assert.ok(queries.some((q) => /FROM editor_channels/i.test(q)), 'the daily job reads the active cards');
  await w.paused();
  assert.ok(queries.some((q) => /series_pauses/.test(q) && /source_unreachable/.test(q)), 'the 6-hourly job reads the open source_unreachable pauses');
});

test('both crons catch and log every error', async () => {
  const queries: string[] = [];
  const w = worker('true', queries, true);
  await assert.doesNotReject(() => w.daily());
  await assert.doesNotReject(() => w.paused());
  assert.ok(queries.length >= 2);
});
