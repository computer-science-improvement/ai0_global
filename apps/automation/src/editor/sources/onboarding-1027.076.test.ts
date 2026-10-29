/**
 * Spec 076, the acceptance replays of the 2026-10-27 onboarding (the fixtures are in fixtures/onboarding-1027.ts, written by hand):
 *   1. @pdr_dev_channel: a page the server cannot reach, three timeouts, one note, a $0 skip, a finding with its fix, and the upload.
 *   2. @ai0_prompts_dev: no card sources, one library series: it is reported, kept in network health, and not "without sources".
 *   3. @ai0_global: healthy feeds and a library series give no error or warn finding and do not stop the live gate.
 * Fakes only: no network, no database, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { nextBlock, type HostBlock, type HostFailureReason, type HostFailures, type NextBlock, type PrevBlock } from '../net/host-failures';
import { SourceHealthService } from './source-health.service';
import type { StruckHost } from './source-health.repository';
import { SlotPreflight, type PreflightDeps } from '../preflight/slot-preflight';
import { preflightCauseOf } from '../silent/skip-reasons';
import { DocStore } from '../docs/doc-store';
import { fetchDocument } from '../docs/doc-fetch';
import { buildPlan } from '../docs/import-list';
import { PDR_HTML, PDR_MAPPING, PDR_SPLIT_ON, PDR_URL } from '../docs/testing/pdr-fixture';
import { NetworkHealthService } from '../health/network-health.service';
import { scanLive } from '../live/feed-items';
import { feedsAllUnreachable } from '../live/live-slot';
import { applyHostProxyAdd, applySourceDrop } from './source-fixes';
import { UploadPageBody, uploadPage } from './upload-page';
import { isTroubled } from './source-health';
import type { ProbeResult } from './probe';
import { sourceFindings, type SourceFindingsInput } from './source-findings';
import {
  freshRss, GLOBAL_AGENT, GLOBAL_CHANNEL, GLOBAL_CREATED_AT, GLOBAL_FEEDS, GLOBAL_NOW, GLOBAL_PLAYBOOK, globalFacts,
  PDR_AGENT, PDR_CHANNEL, PDR_CREATED_AT, PDR_DATASET, PDR_FIRST_TIMEOUT, PDR_HINT, PDR_HOST, PDR_NOW, PDR_SOURCE, PDR_TIMEOUT_AFTER_HOURS, pdrFact,
  plusHours, PROMPTS_AGENT, PROMPTS_CHANNEL, PROMPTS_CREATED_AT, PROMPTS_DATASET, PROMPTS_NOW, PROMPTS_PLAYBOOK, PROMPTS_SERIES, promptsFact,
} from './fixtures/onboarding-1027';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const getHtml = async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: PDR_HTML });
const emptyPool = { query: async () => ({ rows: [] }) } as any;

// ── 1. @pdr_dev_channel ──────────────────────────────────────────────────────────────────────────────────────────────

/** The strike the third read leaves behind: `nextBlock` fed with the three timeouts, the way `record` does. */
function strikeAfterThreeTimeouts(): NextBlock {
  let row: PrevBlock | null = null;
  let last!: NextBlock;
  for (const hours of PDR_TIMEOUT_AFTER_HOURS) {
    const at = plusHours(PDR_FIRST_TIMEOUT, hours);
    last = nextBlock(row, 'timeout', at);
    row = { reason: last.keep && row ? row.reason : last.reason, blockedUntil: last.until, strikes: last.strikes, timeouts: last.timeouts, timeoutsSince: last.timeoutsSince, lastAt: at };
  }
  return last;
}

test('replay 1: three timeouts at least an hour apart are one unreachable strike of a day', () => {
  const strike = strikeAfterThreeTimeouts();
  assert.deepEqual([strike.reason, strike.strikes, strike.timeouts], ['unreachable', 1, 3]);
  assert.equal(strike.until.toISOString(), plusHours(PDR_FIRST_TIMEOUT, 4 + 24).toISOString());
  assert.equal(strike.timeoutsSince?.toISOString(), PDR_FIRST_TIMEOUT.toISOString());
  // Two reads are not enough: the second is still a one-hour timeout block.
  const second = nextBlock({ reason: 'timeout', blockedUntil: plusHours(PDR_FIRST_TIMEOUT, 1), strikes: 0, timeouts: 1, timeoutsSince: PDR_FIRST_TIMEOUT, lastAt: PDR_FIRST_TIMEOUT }, 'timeout', plusHours(PDR_FIRST_TIMEOUT, 2));
  assert.deepEqual([second.reason, second.strikes], ['timeout', 0]);
});

test('replay 1: the strike is told to the owner once, in one note about the channel', async () => {
  const strike = strikeAfterThreeTimeouts();
  const card = makeCard({ channelKey: PDR_CHANNEL, sources: [PDR_SOURCE] });
  const row: StruckHost = {
    host: PDR_HOST, reason: strike.reason, statusCode: null, until: strike.until, failures: 3, strikes: strike.strikes, notedAt: null,
    timeouts: strike.timeouts, timeoutsSince: strike.timeoutsSince, lastSuccessAt: null,
  };
  const posts: any[] = [];
  const gated = new Set<string>();
  const svc = new SourceHealthService({
    repo: { steps: async () => [], blocks: async () => [], playbookOf: async () => null, struck: async (hosts, min) => [row].filter((b) => hosts.includes(b.host) && b.strikes >= min) },
    channels: { get: async () => card }, now: () => PDR_NOW,
    inbox: {
      post: async (i: any) => { posts.push(i); return 1; },
      postOnce: async (i: any) => {
        const key = `${i.gate.subject}|${i.gate.parts.join(',')}`;
        if (gated.has(key)) return null;
        gated.add(key);
        posts.push(i);
        return posts.length;
      },
    },
  });
  assert.deepEqual(await svc.noteStruckHosts(card, 'agent-1'), [PDR_HOST]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].agentId, 'agent-1');
  assert.equal(posts[0].kind, 'host_struck');
  assert.equal(posts[0].refId, `${PDR_CHANNEL}/${PDR_HOST}`);
  assert.equal(posts[0].severity, 'action');
  assert.equal(posts[0].title, `${PDR_HOST} cannot be reached from the server`);
  assert.ok(posts[0].body.startsWith('Timed out 3 times in a row since 2026-10-27; blocked until 2026-10-28 12:00 UTC.'), posts[0].body);
  assert.match(posts[0].body, /A card source: the channel agent looks for a replacement/);
  assert.deepEqual(await svc.noteStruckHosts(card, 'agent-1'), [], 'the same streak is not told twice');
  assert.equal(posts.length, 1);
});

test('replay 1: a planned slot whose hint is the page skips before any model call, as preflight_host_blocked', async () => {
  const strike = strikeAfterThreeTimeouts();
  const asked: string[] = [];
  const hosts: Pick<HostFailures, 'blocked'> = {
    blocked: async (key: string, use: 'page' | 'feed'): Promise<HostBlock | null> => {
      asked.push(`${key}|${use}`);
      return key === PDR_HOST ? { host: key, reason: strike.reason as HostFailureReason, statusCode: null, until: strike.until } : null;
    },
  };
  const deps: PreflightDeps = {
    ledger: { check: async () => ({ used: false }) } as any, hosts,
    ideas: { idea: async () => null, accepted: async () => [], claim: async () => true, release: async () => {} },
    retopic: async () => {}, env: () => undefined, freshnessHours: async () => 36, now: () => PDR_NOW,
  };
  const slot: any = {
    id: 's1', channelKey: PDR_CHANNEL, scheduledAt: PDR_NOW, kind: 'content', format: 'text', topic: 'Обгін', angle: null, sourceHints: [PDR_HINT],
    ideaId: null, seriesName: null, isExperiment: false, status: 'running', attempts: 0,
  };
  const r = await new SlotPreflight(deps).run(slot, makeCard({ channelKey: PDR_CHANNEL, sources: [PDR_SOURCE] }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'preflight_host_blocked');
  assert.equal(preflightCauseOf(!r.ok ? `${r.code}: ${r.reason}` : null), 'source_unreachable', 'the breaker and the pause see an unreachable source, not a bug');
  assert.ok(asked.includes(`${PDR_HOST}|page`), `the host of the hint was asked: ${asked.join(', ')}`);
});

test('replay 1: the doctor says source_probe_failed, with the proxy as the fix when one is set and removing the source when not', () => {
  const base: SourceFindingsInput = {
    channelKey: PDR_CHANNEL, agent: PDR_AGENT, now: PDR_NOW, createdAt: PDR_CREATED_AT, sources: [pdrFact()], proxyConfigured: false, uploadedImports: [],
  };
  const noProxy = sourceFindings(base);
  assert.deepEqual(noProxy.map((f) => [f.check, f.severity]), [['source_probe_failed', 'error']], 'the only source of the card is required');
  assert.deepEqual(noProxy[0].fix, { kind: 'source_drop', channel: PDR_CHANNEL, sourceId: 'pdr_print' });
  assert.equal(noProxy[0].title, `${PDR_HOST}: the server cannot read this source`);
  assert.equal(noProxy[0].detail, 'timed out twice (10 s)');
  assert.equal(noProxy[0].link, `/app/agents/${PDR_AGENT}?tab=settings`);

  const withProxy = sourceFindings({ ...base, proxyConfigured: true });
  assert.deepEqual(withProxy.map((f) => f.check), ['source_probe_failed']);
  assert.deepEqual(withProxy[0].fix, { kind: 'host_proxy_add', host: PDR_HOST });
  assert.equal(withProxy[0].key, noProxy[0].key, 'the same problem keeps its key whatever the fix');

  // Even with no probe yet, the block alone is enough.
  const blockOnly = sourceFindings({ ...base, sources: [pdrFact({ probe: null })], proxyConfigured: true });
  assert.deepEqual(blockOnly.map((f) => f.check), ['source_probe_failed']);
  assert.match(blockOnly[0].detail, /^blocked until 2026-10-28 12:00 UTC \(unreachable, 1 in a row\)$/);
});

test('replay 1: the fixes the findings offer do what they say', async () => {
  const base: SourceFindingsInput = {
    channelKey: PDR_CHANNEL, agent: PDR_AGENT, now: PDR_NOW, createdAt: PDR_CREATED_AT, sources: [pdrFact()], proxyConfigured: false, uploadedImports: [],
  };
  const drop = sourceFindings(base)[0].fix!;
  const saved: unknown[] = [];
  assert.deepEqual(
    await applySourceDrop({ card: async () => ({ sources: [PDR_SOURCE] }), upsert: async (_k, body) => { saved.push(body); } }, drop as any),
    { ok: true, applied: `Removed source “pdr_print” (url ${PDR_URL}) from ${PDR_CHANNEL}` });
  assert.deepEqual(saved, [{ sources: [] }]);

  const add = sourceFindings({ ...base, proxyConfigured: true })[0].fix!;
  const set: string[] = [];
  const env = (k: string) => (k === 'EGRESS_PROXY_URL' ? 'http://user:pass@proxy.example:3128' : undefined);
  assert.deepEqual(await applyHostProxyAdd({ env, setHosts: async (v) => { set.push(v); } }, add as any), { ok: true, applied: `${PDR_HOST} is now read through the proxy` });
  assert.deepEqual(set, [PDR_HOST]);
});

test('replay 1: the saved print page, uploaded with the § 29 mapping, gives the same entries as a live import, and the dataset is marked manual', async () => {
  const args = { dataset: PDR_DATASET, mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'ПДР', license: undefined };
  const live: any = await fetchDocument(PDR_URL, { docs: new DocStore(), http: { lookup, get: getHtml } });
  const docs = new DocStore();
  const up: any = await uploadPage({ docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML }));
  assert.equal(up.error, undefined);

  const fromLive = buildPlan(live.doc, args, null);
  const fromUpload = buildPlan(docs.get(up.doc_id)!, args, null);
  const keys = (rows: Array<Record<string, unknown>>) => rows.map((r) => [r.list_ref, r.source_url]);
  assert.deepEqual(keys(fromUpload.rows), keys(fromLive.rows), 'the same list_ref and source_url for every entry');
  assert.equal(fromUpload.rows.length, 8);
  const clause = fromUpload.rows.find((r: any) => r.clause === '14.6') as any;
  assert.equal(clause.list_ref, `${PDR_URL}#14.6`);
  assert.equal(clause.source_url, PDR_HINT, 'the clause\'s own link, as the planner writes the hint');

  const f = sourceFindings({
    channelKey: PDR_CHANNEL, agent: PDR_AGENT, now: PDR_NOW, createdAt: PDR_CREATED_AT, sources: [pdrFact()], proxyConfigured: true, uploadedImports: [PDR_DATASET],
  });
  assert.deepEqual(f.map((x) => [x.check, x.severity]), [['source_probe_failed', 'error'], ['dataset_resync_manual', 'info']]);
  assert.equal(f[1].link, `/app/data/${PDR_DATASET}`);
  assert.equal(f[1].title, `${PDR_DATASET}: re-sync is manual (uploaded page)`);
});

// ── 2. @ai0_prompts_dev ──────────────────────────────────────────────────────────────────────────────────────────────

const overviewRow = (dataset: string, o: Record<string, unknown> = {}): any => ({ dataset, title: dataset, entity: 'prompt', rows: 90, unposted_here: 12, runway_days: 6, ...o });

function promptsHealth(overview: any[]) {
  const card = makeCard({ channelKey: PROMPTS_CHANNEL, sources: [] });
  const asked: string[] = [];
  const svc = new SourceHealthService({
    repo: { steps: async () => [], blocks: async () => [], playbookOf: async () => PROMPTS_PLAYBOOK },
    channels: { get: async () => card }, now: () => PROMPTS_NOW,
    runway: async (ref) => { asked.push(ref); return overview; },
  });
  return { card, svc, asked };
}

test('replay 2: a card with no sources and a library series is reported, with the runway of its dataset', async () => {
  const { card, svc, asked } = promptsHealth([overviewRow(PROMPTS_DATASET)]);
  const report = await svc.forCard(card);
  assert.equal(report.noSources, false, 'the series is a source');
  assert.deepEqual(report.sources.map((s) => [s.id, s.kind, s.ref, s.origin, s.runway]), [
    [`series:${PROMPTS_SERIES}`, 'library', PROMPTS_DATASET, 'playbook', { unposted: 12, days: 6, rounds: false }],
  ]);
  assert.deepEqual(asked, [`telegram:${PROMPTS_CHANNEL}`]);
});

test('replay 2: there is no card_without_sources finding for it, and there is one for a card with nothing at all', () => {
  const input: SourceFindingsInput = {
    channelKey: PROMPTS_CHANNEL, agent: PROMPTS_AGENT, now: PROMPTS_NOW, createdAt: PROMPTS_CREATED_AT, sources: [promptsFact()], proxyConfigured: false, uploadedImports: [],
  };
  assert.deepEqual(sourceFindings(input), []);
  assert.deepEqual(sourceFindings({ ...input, sources: [] }).map((f) => f.check), ['card_without_sources']);
});

test('replay 2: network health keeps the card, and shows the series row when its dataset has no unposted rows left', async () => {
  for (const [name, overview, expected] of [
    ['rows left', [overviewRow(PROMPTS_DATASET)], []],
    ['none left', [overviewRow(PROMPTS_DATASET, { unposted_here: 0, runway_days: null })], [[PROMPTS_CHANNEL, `series:${PROMPTS_SERIES}`, 'exhausted', { unposted: 0, days: null, rounds: false }]]],
  ] as const) {
    const { card, svc } = promptsHealth([...overview]);
    const asked: string[] = [];
    const health = new NetworkHealthService({
      pool: emptyPool, now: () => PROMPTS_NOW,
      channels: { listActive: async () => [card] },
      sources: async (c) => { asked.push(c.channelKey); return svc.forCard(c); },
      budgets: async () => ({ rows: [], agentCaps: [], blocking: [] }),
    });
    const h = await health.health();
    assert.deepEqual(asked, [PROMPTS_CHANNEL], `${name}: the card with no sources of its own is still asked`);
    assert.deepEqual(h.sources.map((s) => [s.channelKey, s.id, s.state, s.runway]), expected, name);
  }
});

// ── 3. @ai0_global ───────────────────────────────────────────────────────────────────────────────────────────────────

test('replay 3: healthy feeds and a library series give no error and no warn finding', () => {
  const input: SourceFindingsInput = {
    channelKey: GLOBAL_CHANNEL, agent: GLOBAL_AGENT, now: GLOBAL_NOW, createdAt: GLOBAL_CREATED_AT, sources: globalFacts(), proxyConfigured: true, uploadedImports: [],
  };
  const out = sourceFindings(input);
  assert.deepEqual(out.filter((f) => f.severity === 'error' || f.severity === 'warn'), [], 'no false blocker');
  assert.deepEqual(out, [], 'and nothing else either');
  // The same channel the day it was made, before any probe: only a hint, never a blocker.
  const fresh = sourceFindings({ ...input, createdAt: new Date(GLOBAL_NOW.getTime() - 86_400_000), sources: globalFacts().map((f) => ({ ...f, probe: null })) });
  assert.deepEqual(fresh.map((f) => [f.check, f.severity]), [['source_untested', 'info'], ['source_untested', 'info']]);
});

test('replay 3: source health lists the feeds with the server\'s read and the library series with its runway, and none of them is troubled', async () => {
  const card = makeCard({ channelKey: GLOBAL_CHANNEL, sources: GLOBAL_FEEDS });
  const probeOf = (url: string): ProbeResult => ({
    ok: true, failure_class: null, status: 200, kind: 'rss', feed_url: url, items: 24, newest_at: plusHours(GLOBAL_NOW, -3).toISOString(), sample_titles: [],
    checked_at: plusHours(GLOBAL_NOW, -2).toISOString(), via_proxy: false, url, detail: '24 items, newest 3 h ago', ms: 180, cached: false, blocked_until: null,
  });
  const svc = new SourceHealthService({
    repo: { steps: async () => [], blocks: async () => [], playbookOf: async () => GLOBAL_PLAYBOOK },
    channels: { get: async () => card }, now: () => GLOBAL_NOW,
    runway: async () => [overviewRow('prompts', { unposted_here: 40, runway_days: 40 })],
    probes: { latest: async (urls: string[]) => new Map(urls.map((u) => [u, probeOf(u)])) } as any,
  });
  const report = await svc.forCard(card);
  assert.equal(report.noSources, false);
  assert.deepEqual(report.sources.map((s) => [s.id, s.kind, s.probe?.ok ?? null, s.runway]), [
    ['marktechpost', 'rss', true, null], ['verge', 'rss', true, null], ['series:Prompt of the day', 'library', null, { unposted: 40, days: 40, rounds: false }],
  ]);
  assert.deepEqual(report.sources.filter((s) => isTroubled(s)), []);
  assert.deepEqual(await svc.needingReplacement(card), []);
});

test('replay 3: the live gate does not skip a slot whose feeds answer', async () => {
  const bodies: Record<string, string> = {
    [GLOBAL_FEEDS[0].ref]: freshRss(GLOBAL_NOW, 'Лабораторія випустила нову мовну модель', 'a'),
    [GLOBAL_FEEDS[1].ref]: freshRss(GLOBAL_NOW, 'Виробник телефонів показав новий флагман', 'b'),
  };
  const calls: string[] = [];
  const http = { lookup, get: async (u: string) => { calls.push(u); return { status: 200, headers: { 'content-type': 'application/rss+xml' }, data: bodies[u] }; } };
  const ok: string[] = [];
  const hosts: HostFailures = { blocked: async () => null, record: async () => {}, succeeded: async (h: string) => { ok.push(h); } };
  const scan = await scanLive({ pool: emptyPool, http, hosts, retryMs: 0 }, {
    spec: { sources: GLOBAL_FEEDS.map((s) => s.ref), max_age_hours: 6 }, resourceRef: `telegram:${GLOBAL_CHANNEL}`, card: GLOBAL_FEEDS, now: GLOBAL_NOW,
  });
  assert.deepEqual([scan.feedsRead, scan.feedsFailed, scan.feedsUnreachable], [2, 0, 0]);
  assert.equal(scan.items.length, 2);
  assert.equal(feedsAllUnreachable(scan), false);
  assert.deepEqual(calls, GLOBAL_FEEDS.map((s) => s.ref));
  assert.ok(ok.length >= 2, 'a read that works is told to the host record');
});
