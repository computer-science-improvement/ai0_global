/**
 * Spec 076 FR-007 (A19, A20, L5): the guarded live scan and the $0 skip of a slot whose feeds are all unreachable.
 * Stubbed `get` / `lookup`, fake host records, a fake pool and a scripted runner loop; no network and no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedsAllUnreachable, type LiveScan } from './live-slot';
import { liveFeeds, readFeedGuarded, scanLive } from './feed-items';
import { NewsWatchService } from './news-watch';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { makeDefaultCard } from '../chat/default-card';
import { isToolError } from '../harness/tool';
import { preflightCauseOf, skipGroupOf } from '../silent/skip-reasons';
import type { HostBlock, HostFailureReason, HostFailures } from '../net/host-failures';

const NOW = new Date('2030-05-06T12:00:00Z');
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const rss = (items: Array<{ title: string; link: string; date: string }>) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>d</description></item>`).join('')
}</channel></rss>`;
const FRESH = rss([{ title: 'Уряд ухвалив закон про енергоринок', link: 'https://a.example/new', date: '2030-05-06T11:30:00Z' }]);
type Answer = { status: number; headers: Record<string, string>; data: string };
const ok = (data: string): Answer => ({ status: 200, headers: { 'content-type': 'application/rss+xml' }, data });
const status = (s: number): Answer => ({ status: s, headers: { 'content-type': 'text/html' }, data: '' });
const html = (): Answer => ({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html><body><h1>Сторінка</h1></body></html>' });
const timeout = () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const dns = () => Object.assign(new Error('getaddrinfo ENOTFOUND gone.example'), { code: 'ENOTFOUND' });
const tls = () => Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });

class FakeHosts implements HostFailures {
  records: Array<[string, HostFailureReason, number | null | undefined]> = [];
  ok: Array<[string, string | undefined]> = [];
  checks: string[] = [];
  blocks = new Map<string, HostBlock>();
  block(key: string, reason: HostFailureReason = 'timeout'): this {
    this.blocks.set(key, { host: key, reason, statusCode: null, until: new Date(NOW.getTime() + 3_600_000) });
    return this;
  }
  async blocked(host: string, use: 'page' | 'feed') { this.checks.push(`${host}|${use}`); return this.blocks.get(host) ?? null; }
  async record(host: string, reason: HostFailureReason, code?: number | null) { this.records.push([host, reason, code]); }
  async succeeded(host: string, use?: 'page' | 'feed') { this.ok.push([host, use]); }
}

/** A scripted `get`: each URL maps to a list of answers, the last one repeats; an Error is thrown. */
function http(script: Record<string, Array<Answer | Error>>) {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const get = async (u: string) => {
    calls.push(u);
    const list = script[u] ?? [status(404)];
    const n = seen.get(u) ?? 0;
    seen.set(u, n + 1);
    const a = list[Math.min(n, list.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, seams: { lookup, get } };
}

const A = 'https://a.example/rss';
const B = 'https://b.example/rss';
const emptyPool = { query: async () => ({ rows: [] }) } as any;

test('readFeedGuarded: a block on the host or on the feed address answers without a request', async () => {
  const byHost = http({ [A]: [ok(FRESH)] });
  const r1 = await readFeedGuarded(A, NOW, { http: byHost.seams, hosts: new FakeHosts().block('a.example', 'unreachable') });
  assert.deepEqual(r1, { ok: false, unreachable: true, host: 'a.example', why: 'blocked' });
  const byKey = http({ [A]: [ok(FRESH)] });
  const hosts = new FakeHosts().block('a.example/rss', 'feed_refused');
  const r2 = await readFeedGuarded(A, NOW, { http: byKey.seams, hosts });
  assert.deepEqual(r2, { ok: false, unreachable: true, host: 'a.example', why: 'blocked' });
  assert.deepEqual(hosts.checks, ['a.example|feed', 'a.example/rss|feed'], 'the host first, then the address, both with use feed');
  assert.deepEqual([byHost.calls.length, byKey.calls.length], [0, 0], 'no request was made');
});

test('readFeedGuarded: a timeout, a reset that survives the retry, DNS and TLS are recorded on the host and the address and are unreachable', async () => {
  for (const [name, errors, why, reason, tries] of [
    ['timeout', [timeout()], 'timeout', 'timeout', 1],
    ['reset', [reset(), reset()], 'timeout', 'timeout', 2],
    ['dns', [dns()], 'dns', 'dns', 1],
    ['tls', [tls()], 'tls', 'tls', 1],
  ] as const) {
    const h = http({ [A]: [...errors] });
    const hosts = new FakeHosts();
    const r = await readFeedGuarded(A, NOW, { http: h.seams, hosts, retryMs: 0 });
    assert.deepEqual(r, { ok: false, unreachable: true, host: 'a.example', why }, name);
    assert.deepEqual(hosts.records, [['a.example', reason, undefined], ['a.example/rss', reason, undefined]], name);
    assert.equal(h.calls.length, tries, `${name}: requests`);
    assert.deepEqual(hosts.ok, [], name);
  }
  // A reset that the retry cures is a success.
  const cured = http({ [A]: [reset(), ok(FRESH)] });
  const hosts = new FakeHosts();
  const r = await readFeedGuarded(A, NOW, { http: cured.seams, hosts, retryMs: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(hosts.records, []);
});

test('readFeedGuarded: an HTTP status, a body that is not a feed and any other error are failed and are NOT recorded', async () => {
  for (const [name, answer] of [['403', status(403)], ['404', status(404)], ['500', status(500)], ['html', html()], ['other', new Error('boom')]] as const) {
    const h = http({ [A]: [answer] });
    const hosts = new FakeHosts();
    const r = await readFeedGuarded(A, NOW, { http: h.seams, hosts, retryMs: 0 });
    assert.equal(r.ok, false, name);
    assert.equal(!r.ok && r.unreachable, false, name);
    assert.ok(!r.ok && !r.unreachable && r.error.length > 0, name);
    assert.deepEqual(hosts.records, [], `${name}: nothing is recorded`);
    assert.deepEqual(hosts.ok, [], `${name}: no success either`);
  }
});

test('readFeedGuarded: a read calls succeeded on the host and on the address with use feed; without hosts it just reads', async () => {
  const h = http({ [A]: [ok(FRESH)] });
  const hosts = new FakeHosts();
  const r = await readFeedGuarded(A, NOW, { http: h.seams, hosts });
  assert.ok(r.ok && r.feed.items.length === 1 && r.feed.title === 'Feed');
  assert.deepEqual(hosts.ok, [['a.example', 'feed'], ['a.example/rss', 'feed']]);
  const plain = await readFeedGuarded(A, NOW, { http: http({ [A]: [ok(FRESH)] }).seams });
  assert.equal(plain.ok, true);
  const noArgs = await readFeedGuarded('ftp://a.example/rss', NOW, { http: h.seams });
  assert.equal(noArgs.ok, false, 'an address that is not http fails and is never recorded');
});

test('liveFeeds tags each entry rss or url: the card source kind, FEEDISH for a bare address', () => {
  const card = [{ id: 'f1', kind: 'rss' as const, ref: 'https://e.example/x' }, { id: 'p1', kind: 'url' as const, ref: 'https://e.example/list' }];
  assert.deepEqual(liveFeeds(['f1', 'feed:p1', 'https://x.example/feed.xml', 'https://x.example/news', 'api:nasa'], card), {
    feeds: [
      { url: 'https://e.example/x', id: 'f1', kind: 'rss' }, { url: 'https://e.example/list', id: 'p1', kind: 'url' },
      { url: 'https://x.example/feed.xml', id: 'https://x.example/feed.xml', kind: 'rss' }, { url: 'https://x.example/news', id: 'https://x.example/news', kind: 'url' },
    ],
    other: ['api:nasa'],
  });
});

test('scanLive counts failed, unreachable and page sources; every entry goes through the guarded reader', async () => {
  const P = 'https://p.example/list';
  const h = http({ [A]: [timeout()], [P]: [html()] });
  const hosts = new FakeHosts().block('b.example', 'unreachable');
  const scan = await scanLive({ pool: emptyPool, http: h.seams, hosts, retryMs: 0 }, {
    spec: { sources: [A, B, P], max_age_hours: 6 }, resourceRef: 'telegram:@x', card: [], now: NOW,
  });
  assert.deepEqual([scan.feedsRead, scan.feedsFailed, scan.feedsUnreachable, scan.pageSources], [0, 3, 2, 1]);
  assert.deepEqual(h.calls, [A, P], 'the blocked feed made no request');
  assert.deepEqual(hosts.records, [['a.example', 'timeout', undefined], ['a.example/rss', 'timeout', undefined]], 'the page parse error is not recorded');
  assert.equal(feedsAllUnreachable(scan), false, 'a page source is still left for the writer');

  const good = await scanLive({ pool: emptyPool, http: http({ [A]: [ok(FRESH)] }).seams, hosts: new FakeHosts() }, {
    spec: { sources: [A], max_age_hours: 6 }, resourceRef: 'telegram:@x', card: [], now: NOW,
  });
  assert.deepEqual([good.feedsRead, good.feedsFailed, good.feedsUnreachable, good.pageSources, good.items.length], [1, 0, 0, 0, 1]);
});

test('scanLive without hosts reads as before (a failure is only counted)', async () => {
  const scan = await scanLive({ pool: emptyPool, http: http({ [A]: [timeout()] }).seams }, {
    spec: { sources: [A], max_age_hours: 6 }, resourceRef: 'telegram:@x', card: [], now: NOW,
  });
  assert.deepEqual([scan.feedsRead, scan.feedsFailed, scan.feedsUnreachable], [0, 1, 1]);
});

test('the gate condition: only feeds, all unreachable, none read; a typed LiveScan without the new fields never skips', () => {
  const base: LiveScan = { items: [], feedsRead: 0, feedsFailed: 2, otherSources: [], dropped: { old: 0, undated: 0, posted: 0, similar: 0 } };
  assert.equal(feedsAllUnreachable(base), false, 'a typed fake without the new fields');
  assert.equal(feedsAllUnreachable({ ...base, feedsUnreachable: 2 }), true);
  assert.equal(feedsAllUnreachable({ ...base, feedsUnreachable: 2, pageSources: 0 }), true);
  assert.equal(feedsAllUnreachable({ ...base, feedsUnreachable: 1 }), false, 'one feed failed for another reason (an HTTP status, a parse error)');
  assert.equal(feedsAllUnreachable({ ...base, feedsUnreachable: 2, pageSources: 1 }), false, 'a page source can still be opened');
  assert.equal(feedsAllUnreachable({ ...base, feedsUnreachable: 2, otherSources: ['api:nasa_apod'] }), false, 'an api source can still be read');
  assert.equal(feedsAllUnreachable({ ...base, feedsRead: 1, feedsUnreachable: 2 }), false, 'a feed was read');
  assert.equal(feedsAllUnreachable({ ...base, feedsFailed: 0, feedsUnreachable: 0 }), false, 'nothing failed');
});

// ── the runner gate ──────────────────────────────────────────────────────────────────────────────────────────────────
const SLOT: any = {
  id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'text', topic: 'Свіжа новина', angle: null, sourceHints: [], isExperiment: false, attempts: 1,
  topicMode: 'live', liveSpec: { sources: [A, B], brief: 'Новини', max_age_hours: 6, origin: 'planner' },
};
const shadowed = (st: any) => { Object.assign(st, { status: 'shadowed', error: null, critic: { verdict: 'pass', notes: 'ok', cost_usd: 0.002 } }); return { ok: true, shadow: true }; };

function runner(scan: (() => Promise<LiveScan | null>) | null) {
  const st: any = { ...SLOT, status: 'running', error: null, critic: null };
  const runs: any[] = [];
  const publish = { name: 'publish_post', kind: 'terminal', description: '', input: {} as any, roles: ['executor'], execute: async () => shadowed(st) };
  const r = new EditorRunnerService({
    loop: {
      run: async (i: any) => {
        runs.push(i);
        const tool = i.tools.find((t: any) => t.name === 'publish_post');
        const res = await tool.execute({ spec: { format: 'text', source: { url: 'https://a.example/new' } } }, {});
        return { runId: `r${runs.length}`, status: isToolError(res) ? 'max_steps' : 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 } } as any;
      },
    },
    registry: { forRole: () => [publish] as any },
    skills: new SkillLibrary(),
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...st }), updateSlot: async (_id: string, p: any) => { Object.assign(st, p); } },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    ...(scan ? { live: { scan: async () => scan() } } : {}),
  } as any);
  return { r, st, runs, card: makeCard({}) };
}
const unreachableScan = (over: Partial<LiveScan> = {}): LiveScan => ({
  items: [], feedsRead: 0, feedsFailed: 2, feedsUnreachable: 2, pageSources: 0, otherSources: [], dropped: { old: 0, undated: 0, posted: 0, similar: 0 }, ...over,
});

test('the runner skips a live slot whose feeds are all unreachable: preflight_host_blocked, the hosts named, no model call', async () => {
  const s = runner(async () => unreachableScan());
  await s.r.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 0, 'no executor run, so no model spend');
  assert.equal(s.st.status, 'skipped');
  assert.equal(s.st.error, 'preflight_host_blocked: усі стрічки слота недоступні з сервера: a.example, b.example');
  assert.equal(preflightCauseOf(s.st.error), 'source_unreachable');
  assert.equal(skipGroupOf(s.st.error), 'nothing_fresh');
});

test('the runner still runs a slot with a page source, an api source, a feed that failed otherwise, a fake without the new fields, or a scan that threw', async () => {
  const cases: Array<[string, (() => Promise<LiveScan | null>) | null]> = [
    ['page source', async () => unreachableScan({ pageSources: 1 })],
    ['api source', async () => unreachableScan({ otherSources: ['api:nasa_apod'] })],
    ['one feed failed with a status', async () => unreachableScan({ feedsUnreachable: 1 })],
    ['typed fake without the new fields', async () => ({ items: [], feedsRead: 0, feedsFailed: 2, otherSources: [], dropped: { old: 0, undated: 0, posted: 0, similar: 0 } })],
    ['scan threw', async () => { throw new Error('db down'); }],
    ['no live wiring', null],
  ];
  for (const [name, scan] of cases) {
    const s = runner(scan);
    await s.r.runExecutor(s.st, s.card);
    assert.equal(s.runs.length, 1, name);
    assert.equal(s.st.status, 'shadowed', name);
  }
});

// ── the news watch ───────────────────────────────────────────────────────────────────────────────────────────────────
test('the news watch reads its feeds through the guarded reader: a blocked feed is skipped without a request and counted as failed', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: /FROM editor_plans/.test(sql) ? [{ id: 'p1', rationale: 'Звичайний план' }] : [] };
    },
  } as any;
  const card = { ...makeDefaultCard('@w', 'Енергетика: новини'), mode: 'live' as const, timezone: 'UTC', brief: 'Новини енергетики', formats: { text: 1 }, sources: [{ id: 'f1', kind: 'rss' as const, ref: A }, { id: 'f2', kind: 'rss' as const, ref: B }] };
  // The readable feed holds only an old item, so the watch adds nothing and the test needs no slot tables.
  const OLD = rss([{ title: 'Старе про тарифи', link: 'https://a.example/old', date: '2030-05-05T08:00:00Z' }]);
  const h = http({ [A]: [ok(OLD)], [B]: [timeout()] });
  const hosts = new FakeHosts().block('b.example', 'unreachable');
  const logs: string[] = [];
  const watch = new NewsWatchService({ pool, profile: async () => null, http: h.seams, hosts, log: (m) => logs.push(m) });
  const res = await watch.check(card, NOW, { force: true });
  assert.equal(res.status, 'checked');
  assert.deepEqual(h.calls, [A], 'the blocked feed made no request');
  assert.ok(logs.some((l) => /feed f2 failed: b\.example unreachable \(blocked\)/.test(l)), logs.join('|'));
  assert.deepEqual(hosts.ok, [['a.example', 'feed'], ['a.example/rss', 'feed']]);
});

test('scanLive: nothing within the slot window → items within 24 h, widenedTo set; older than a day still skips (2026-11-07)', async () => {
  const day = rss([{ title: 'Google показала нову модель для перекладу', link: 'https://a.example/day', date: '2030-05-05T22:00:00Z' }]);
  const wide = await scanLive({ pool: emptyPool, http: http({ [A]: [ok(day)] }).seams }, {
    spec: { sources: [A], max_age_hours: 6 }, resourceRef: 'telegram:@x', card: [], now: NOW,
  });
  assert.deepEqual([wide.items.length, wide.widenedTo], [1, 24]);
  const fresh = await scanLive({ pool: emptyPool, http: http({ [A]: [ok(FRESH)] }).seams }, {
    spec: { sources: [A], max_age_hours: 6 }, resourceRef: 'telegram:@x', card: [], now: NOW,
  });
  assert.equal(fresh.widenedTo, undefined, 'a fresh item needs no wider window');
  const old = rss([{ title: 'Стара новина', link: 'https://a.example/old', date: '2030-05-04T09:00:00Z' }]);
  const none = await scanLive({ pool: emptyPool, http: http({ [A]: [ok(old)] }).seams }, {
    spec: { sources: [A], max_age_hours: 6 }, resourceRef: 'telegram:@x', card: [], now: NOW,
  });
  assert.deepEqual([none.items.length, none.widenedTo], [0, undefined]);
});
