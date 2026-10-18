/** Spec 049 FR-003 / FR-004: source health per channel card, and the replacement a channel agent proposes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSource } from '../card';
import { makeCard } from '../post/testing/fixtures';
import { needsReplacement, sourceHealthOf, sourceHealthReport, type HostBlockRow, type SourceStep } from './source-health';
import { applySourceChange, checkCandidate } from './source-change';
import { SourceHealthService, sourcesToReplaceBlock } from './source-health.service';
import { applySourceChangeAction, buildSourceTools } from './source-tools';

const NOW = new Date('2026-10-18T12:00:00Z');
const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const FEED: CardSource = { id: 'verge', kind: 'rss', ref: 'https://www.theverge.com/rss/index.xml' };
const PAGE: CardSource = { id: 'site', kind: 'url', ref: 'https://example.org/news' };
const DATA: CardSource = { id: 'facts', kind: 'library', ref: 'facts' };
const API: CardSource = { id: 'apod', kind: 'api', ref: 'nasa_apod' };

const step = (o: Partial<SourceStep> & Pick<SourceStep, 'tool'>): SourceStep => ({
  at: h(1), input: null, isError: false, error: null, details: null, items: 5, slotId: null, slotStatus: null, ...o,
});
const feedCall = (at: number, ok: boolean, slot: string | null = null, status: string | null = null) => step({
  tool: 'fetch_feed', at: h(at), input: { url: 'https://theverge.com/rss/index.xml/' }, isError: !ok,
  error: ok ? null : 'http_error', details: ok ? null : 'status 403', items: ok ? 6 : null, slotId: slot, slotStatus: status,
});

test('a feed that keeps refusing is failing; the slots it cost are counted; the detail says what happened', () => {
  const steps = [feedCall(100, true, 's0', 'published'), feedCall(50, false, 's1', 'skipped'), feedCall(30, false, 's2', 'failed'), feedCall(20, false, 's2', 'failed'), feedCall(5, false, 's3', 'published')];
  const r = sourceHealthOf(FEED, steps, [], NOW);
  assert.equal(r.state, 'failing');
  assert.deepEqual([r.calls, r.ok, r.errors, r.successRate], [5, 1, 4, 0.2]);
  assert.equal(r.slotsLost, 2, 's1 and s2 did not go out; s3 did');
  assert.equal(r.lastOkAt, h(100).toISOString());
  assert.match(r.detail, /^1 of 5 reads worked in 14 d; last error 5 h ago: http_error — status 403; last good read 4 d ago; 2 slots lost$/);
  assert.equal(needsReplacement(r), true);
});

test('blocked, exhausted, ok and unused; a feed block does not stop a page source', () => {
  const block = (host: string, reason: string, failures = 1): HostBlockRow => ({ host, reason, statusCode: 403, until: new Date(NOW.getTime() + 3_600_000), failures });
  const once = sourceHealthOf(PAGE, [], [block('example.org', 'refused')], NOW);
  assert.equal(once.state, 'blocked');
  assert.equal(needsReplacement(once), false, 'one 24-hour block is a blip');
  assert.equal(needsReplacement(sourceHealthOf(PAGE, [], [block('example.org', 'refused', 2)], NOW)), true);
  assert.equal(sourceHealthOf(PAGE, [], [block('example.org', 'feed_unparseable')], NOW).state, 'unused');
  assert.equal(sourceHealthOf(FEED, [], [block('theverge.com/rss/index.xml', 'feed_too_large')], NOW).state, 'blocked');

  const rows = (n: number) => step({ tool: 'query_data', input: { schema: 'facts' }, items: n });
  assert.equal(sourceHealthOf(DATA, [rows(4), rows(0), rows(0), rows(0)], [], NOW).state, 'exhausted');
  assert.equal(sourceHealthOf(DATA, [rows(0), rows(0), rows(3)], [], NOW).state, 'ok');
  assert.equal(sourceHealthOf(API, [step({ tool: 'fetch_api', input: { source: 'nasa_apod' } })], [], NOW).state, 'ok');
  assert.equal(sourceHealthOf(API, [], [], NOW).state, 'unused');
});

test('the report lists the worst sources first and the blocked hosts the runs hit outside the card', () => {
  const steps = [feedCall(10, false), feedCall(9, false), feedCall(8, false), step({ tool: 'web_fetch', input: { url: 'https://paywalled.com/a' }, isError: true, error: 'host_blocked' })];
  const blocks: HostBlockRow[] = [{ host: 'paywalled.com', reason: 'refused', statusCode: 403, until: new Date(NOW.getTime() + 60_000), failures: 3 }];
  const r = sourceHealthReport('@c', [DATA, FEED], steps, blocks, NOW);
  assert.deepEqual(r.sources.map((s) => [s.id, s.state]), [['verge', 'failing'], ['facts', 'unused']]);
  assert.deepEqual(r.otherHosts.map((o) => [o.host, o.calls]), [['paywalled.com', 1]]);
});

test('a source change: a replacement keeps the id, an addition gets one, a duplicate or an unknown source is refused', () => {
  const sources = [FEED, DATA];
  const rep = applySourceChange(sources, { action: 'replace', sourceId: 'verge', source: { kind: 'rss', ref: 'https://arstechnica.com/feed/' } });
  assert.ok(Array.isArray(rep));
  assert.deepEqual(rep[0], { id: 'verge', kind: 'rss', ref: 'https://arstechnica.com/feed/' });
  const add = applySourceChange(sources, { action: 'add', source: { kind: 'rss', ref: 'https://www.wired.com/feed/rss' } });
  assert.ok(Array.isArray(add) && add[2].id === 'wired_com');
  assert.deepEqual((applySourceChange(sources, { action: 'add', source: { kind: 'rss', ref: 'https://theverge.com/rss/index.xml' } }) as any).error, 'already_a_source');
  assert.deepEqual((applySourceChange(sources, { action: 'remove', sourceId: 'nope' }) as any).error, 'unknown_source');
  assert.deepEqual(applySourceChange(sources, { action: 'remove', sourceId: 'facts' }), [FEED]);
});

test('a candidate is read before the owner sees it: stale, empty and blocked candidates are refused', async () => {
  const feed = (ages: Array<number | null>) => ({ readFeed: async () => ({ items: ages.map((a) => ({ age_hours: a })) }) });
  assert.deepEqual(await checkCandidate({ kind: 'rss', ref: 'https://a.test/feed' }, feed([3, 20])), { ok: true, evidence: '2 items, newest 3 h old' });
  assert.equal((await checkCandidate({ kind: 'rss', ref: 'https://a.test/feed' }, feed([24 * 40]))).ok, false);
  assert.equal((await checkCandidate({ kind: 'rss', ref: 'https://a.test/feed' }, feed([]))).ok, false);
  const blocked = await checkCandidate({ kind: 'url', ref: 'https://b.test/x' }, {
    page: async () => ({ status: 200 }),
    hosts: { blocked: async (host) => ({ host, reason: 'refused', statusCode: 403, until: new Date(NOW.getTime() + 1000) }) },
  });
  assert.deepEqual(blocked.ok ? null : blocked.error, 'candidate_blocked');
  assert.deepEqual(await checkCandidate({ kind: 'library', ref: 'facts' }, { dataset: async () => ({ active: true, rows: 12 }) }), { ok: true, evidence: '12 rows' });
  assert.equal((await checkCandidate({ kind: 'api', ref: 'nasa_apod' }, { api: async () => { throw new Error('status 500'); } })).ok, false);
});

test('propose_source_change: checks the candidate, refuses a repeat, proposes one card; Apply changes the card as it is now', async () => {
  let card = makeCard({ channelKey: '@c', sources: [FEED, DATA] });
  const proposed: any[] = [];
  let handled: 'pending' | 'declined' | null = null;
  const [, propose] = buildSourceTools({
    health: { forChannel: async () => null },
    channels: { get: async () => card },
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa1', ...a }; } },
    candidate: { readFeed: async (url) => ({ items: url.includes('dead') ? [] : [{ age_hours: 2 }] }) },
    handled: async () => handled,
  });
  const ctx: any = { channelKey: '@c', extras: { orchestrator: { id: 'orch' } } };
  const dead = await propose.execute({ action: 'replace', source_id: 'verge', source: { kind: 'rss', ref: 'https://dead.test/feed' }, reason: 'verge answers 403 to every read' }, ctx);
  assert.equal((dead as any).error, 'candidate_empty');
  const ok = await propose.execute({ action: 'replace', source_id: 'verge', source: { kind: 'rss', ref: 'https://arstechnica.com/feed/' }, reason: 'verge answers 403 to every read' }, ctx);
  assert.equal((ok as any).pending_action, 'pa1');
  assert.equal(proposed[0].kind, 'change_source');
  assert.equal(proposed[0].agentId, 'orch');
  assert.match(proposed[0].summary, /^Replace source «verge» \(rss https:\/\/www\.theverge\.com\/rss\/index\.xml\) with rss https:\/\/arstechnica\.com\/feed\/ on @c\. Why: .* Checked now: 1 items, newest 2 h old\.$/);
  handled = 'declined';
  assert.equal(((await propose.execute({ action: 'remove', source_id: 'verge', reason: 'verge answers 403 to every read' }, ctx)) as any).error, 'owner_declined');

  const upserts: any[] = [];
  const r = await applySourceChangeAction(proposed[0].payload, { channels: { get: async () => card }, upsert: async (k, p) => { upserts.push([k, p]); card = { ...card, ...p }; } });
  assert.deepEqual(r, { channel: '@c', sources: 2 });
  assert.equal(card.sources[0].ref, 'https://arstechnica.com/feed/');
  await assert.rejects(applySourceChangeAction({ ...proposed[0].payload, sourceId: 'gone' }, { channels: { get: async () => card }, upsert: async () => {} }), /unknown_source/);
});

test('the daily run is asked about a failing source at most weekly, with one owner note; the prompt block names it', async () => {
  const card = makeCard({ channelKey: '@c', sources: [FEED, DATA] });
  const posted: any[] = [];
  const asked = new Set<string>();
  const pool: any = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('FROM pending_actions')) return { rows: [] };
      if (sql.includes('FROM agent_inbox')) return { rows: (params[1] as string[]).filter((r) => asked.has(r)).map((ref_id) => ({ ref_id })) };
      return { rows: [] };
    },
  };
  const svc = new SourceHealthService({
    repo: { steps: async () => [feedCall(10, false), feedCall(9, false), feedCall(8, false)], blocks: async () => [] },
    channels: { get: async () => card }, pool, now: () => NOW,
    inbox: { post: async (i: any) => { posted.push(i); asked.add(i.refId); return 1; } },
  });
  const first = await svc.toReplaceToday(card, 'orch');
  assert.deepEqual(first.map((s) => s.id), ['verge']);
  assert.equal(posted.length, 1);
  assert.match(posted[0].title, /^Source «verge» of @c is failing$/);
  assert.deepEqual(await svc.toReplaceToday(card, 'orch'), [], 'asked this week');
  assert.match(sourcesToReplaceBlock(first)!, /«verge» \(rss https:\/\/www\.theverge\.com\/rss\/index\.xml\) — не відповідає: 0 of 3 reads worked/);
  assert.equal(sourcesToReplaceBlock([]), null);
});
