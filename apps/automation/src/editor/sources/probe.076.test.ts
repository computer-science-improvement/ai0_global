/**
 * Spec 076 FR-001 (A11, A12, A33): the server-side probe of a source address. Stubbed `get` / `lookup`, a fake host record and an
 * in-memory cache; no network. The real `source_probes` table is covered by net/source-reach.076.pg.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverFeed, probeSource, PROBE_CACHE_HOURS, type ProbeOpts, type ProbeResult, type SourceProbeStore } from './probe';
import { checkCandidate, type CandidateDeps } from './source-change';
import type { HostBlock, HostFailureReason, HostFailures } from '../net/host-failures';

const NOW = new Date('2026-10-29T12:00:00Z');
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const h = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const rss = (items: Array<{ title: string; date?: Date }>) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${
  items.map((i, n) => `<item><title>${i.title}</title><link>https://e.example/${n}</link>${i.date ? `<pubDate>${i.date.toUTCString()}</pubDate>` : ''}<description>d</description></item>`).join('')
}</channel></rss>`;
const TEXT = 'Текст сторінки про правила дорожнього руху. '.repeat(8);
const page = (head = '', body = `<h1>Правила</h1><p>${TEXT}</p>`) => `<html><head><title>Сторінка</title>${head}</head><body><main>${body}</main></body></html>`;
type Answer = { status: number; headers: Record<string, string>; data: string };
const ok = (data: string, contentType = 'text/html'): Answer => ({ status: 200, headers: { 'content-type': contentType }, data });
const status = (s: number, data = ''): Answer => ({ status: s, headers: { 'content-type': 'text/html' }, data });
const timeout = () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });

class FakeHosts implements HostFailures {
  records: Array<[string, HostFailureReason, number | null | undefined]> = [];
  ok: Array<[string, string | undefined]> = [];
  checks: string[] = [];
  blocks = new Map<string, HostBlock>();
  async blocked(host: string, use: 'page' | 'feed') { this.checks.push(`${host}|${use}`); return this.blocks.get(host) ?? null; }
  async record(host: string, reason: HostFailureReason, code?: number | null) { this.records.push([host, reason, code]); }
  async succeeded(host: string, use?: 'page' | 'feed') { this.ok.push([host, use]); }
}
class MemoryStore implements SourceProbeStore {
  rows = new Map<string, ProbeResult>();
  puts = 0;
  async get(url: string) { return this.rows.get(url) ?? null; }
  async put(r: ProbeResult) { this.puts++; this.rows.set(r.url, r); }
}
/** A probe over a scripted `get`: each call takes the next answer (a throw when it is an Error). */
function probe(url: string, answers: Array<ReturnType<typeof ok> | Error | ((u: string) => ReturnType<typeof ok>)>, o: ProbeOpts = {}) {
  const urls: string[] = [];
  const cfgs: Array<Record<string, unknown>> = [];
  let i = 0;
  const get = async (u: string, cfg: Record<string, unknown>) => {
    urls.push(u);
    cfgs.push(cfg);
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(u) : a;
  };
  const run = probeSource(url, { now: () => NOW, retryMs: 0, ...o, http: { lookup, get, ...o.http } });
  return { run, urls, cfgs };
}

test('an RSS feed: items, the newest date, five titles of at most 120 characters, and the line the panel shows', async () => {
  const long = 'Д'.repeat(200);
  const items = [{ title: 'Перша', date: h(2) }, { title: long, date: h(5) }, ...['Третя', 'Четверта', 'П\'ята', 'Шоста'].map((title, n) => ({ title, date: h(10 + n) }))];
  const r = await probe('https://e.example/rss', [ok(rss(items), 'application/rss+xml')], { kind: 'rss' }).run;
  assert.deepEqual([r.ok, r.failure_class, r.kind, r.status, r.items, r.cached, r.blocked_until], [true, null, 'rss', 200, 6, false, null]);
  assert.equal(r.newest_at, h(2).toISOString());
  assert.equal(r.sample_titles.length, 5);
  assert.ok(r.sample_titles.every((t) => t.length <= 120));
  assert.equal(r.detail, '6 items, newest 2 h ago');
  assert.equal(r.feed_url, 'https://e.example/rss');
  assert.equal(r.url, 'https://e.example/rss');
  assert.equal(r.checked_at, NOW.toISOString());
  assert.equal(r.via_proxy, false);
  assert.equal(typeof r.ms, 'number');
});

test('a feed with no items is empty; a url given as a page but answering a feed is detected as one', async () => {
  const empty = await probe('https://e.example/rss', [ok(rss([]), 'application/rss+xml')], { kind: 'rss' }).run;
  assert.deepEqual([empty.ok, empty.failure_class, empty.kind, empty.items, empty.detail], [false, 'empty', 'rss', 0, 'the feed has no items']);
  const detected = await probe('https://e.example/rss', [ok(rss([{ title: 'A', date: h(30) }]), 'application/rss+xml')], { kind: 'url' }).run;
  assert.deepEqual([detected.ok, detected.kind, detected.items, detected.detail], [true, 'rss', 1, '1 item, newest 30 h ago']);
  const none = await probe('https://e.example/rss', [ok(rss([{ title: 'A' }]), 'application/rss+xml')]).run;
  assert.deepEqual([none.kind, none.newest_at, none.detail], ['rss', null, '1 item, no dates']);
});

test('A12: a url page without a feed link: ok with its character count; items are the aggregator links, 0 allowed, never "0 items"', async () => {
  const plain = await probe('https://zakon.example/print', [ok(page())], { kind: 'url' }).run;
  assert.deepEqual([plain.ok, plain.kind, plain.items, plain.feed_url], [true, 'page', 0, null]);
  assert.match(plain.detail, /^page, \d+ chars$/);
  assert.deepEqual(plain.sample_titles, ['Правила'], 'the first section headings');
  const agg = page('', `<h1>News</h1><p>${TEXT}</p><a href="https://openai.com/index/gpt">gpt</a><a href="https://anthropic.com/news/x">x</a>`);
  const r = await probe('https://www.marktechpost.com/2026/10/x', [ok(agg)], { kind: 'url' }).run;
  assert.deepEqual([r.ok, r.items], [true, 2]);
  const thin = await probe('https://e.example/p', [ok(page('', '<p>коротко</p>'))], { kind: 'url' }).run;
  assert.deepEqual([thin.ok, thin.failure_class], [false, 'empty']);
});

test('a page with a feed link reads that feed once: its items and titles are the result', async () => {
  const head = '<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">';
  const t = probe('https://e.example/news', [ok(page(head)), ok(rss([{ title: 'З фіду', date: h(1) }, { title: 'Ще', date: h(3) }]), 'application/rss+xml')], { kind: 'url' });
  const r = await t.run;
  assert.deepEqual(t.urls, ['https://e.example/news', 'https://e.example/feed.xml']);
  assert.deepEqual([r.ok, r.kind, r.feed_url, r.items, r.sample_titles, r.newest_at], [true, 'page', 'https://e.example/feed.xml', 2, ['З фіду', 'Ще'], h(1).toISOString()]);
  assert.match(r.detail, /^2 items, newest 1 h ago \(feed https:\/\/e\.example\/feed\.xml\)$/);
  // The feed fails: the page result stays OK and the detail names the failure.
  const bad = await probe('https://e.example/news', [ok(page(head)), status(500)], { kind: 'url' }).run;
  assert.deepEqual([bad.ok, bad.feed_url, bad.items], [true, 'https://e.example/feed.xml', 0]);
  assert.match(bad.detail, /^page, \d+ chars; its feed https:\/\/e\.example\/feed\.xml answered HTTP 500$/);
  const down = await probe('https://e.example/news', [ok(page(head)), timeout()], { kind: 'url' }).run;
  assert.match(down.detail, /its feed https:\/\/e\.example\/feed\.xml failed: timed out twice \(10 s\)$/);
  assert.equal(discoverFeed(page('<link rel="alternate" type="application/atom+xml" href="https://x.example/a.atom"><link rel="stylesheet" href="/s.css">'), 'https://e.example/'), 'https://x.example/a.atom');
  assert.equal(discoverFeed(page('<link rel="alternate" hreflang="en" href="/en">'), 'https://e.example/'), null);
});

test('A12: kind rss on a page is empty ("not a feed") and names the feed the page links to, without reading it', async () => {
  const head = '<link rel="alternate" type="application/rss+xml" href="/feed.xml">';
  const t = probe('https://e.example/news', [ok(page(head))], { kind: 'rss' });
  const r = await t.run;
  assert.deepEqual([r.ok, r.failure_class, r.kind, r.feed_url], [false, 'empty', 'page', 'https://e.example/feed.xml']);
  assert.equal(r.detail, 'not a feed; the page names the feed https://e.example/feed.xml');
  assert.equal(t.urls.length, 1, 'the named feed is not read');
  const none = await probe('https://e.example/news', [ok(page())], { kind: 'rss' }).run;
  assert.deepEqual([none.failure_class, none.detail, none.feed_url], ['empty', 'not a feed', null]);
});

test('HTTP statuses: 401 / 403 / 429 / 451 are refused, any other 400+ is http', async () => {
  for (const s of [401, 403, 429, 451]) {
    const r = await probe('https://e.example/a', [status(s)], { kind: 'url' }).run;
    assert.deepEqual([r.ok, r.failure_class, r.status], [false, 'refused', s], String(s));
  }
  for (const s of [404, 410, 500, 503]) {
    const r = await probe('https://e.example/a', [status(s)], { kind: 'url' }).run;
    assert.deepEqual([r.failure_class, r.status, r.detail], ['http', s, `HTTP ${s}`], String(s));
  }
});

test('two timeouts are a timeout after two tries and one record on the host; a timeout then OK is OK', async () => {
  const hosts = new FakeHosts();
  const t = probe('https://geo.example/print', [timeout()], { kind: 'url', hosts });
  const r = await t.run;
  assert.deepEqual([r.ok, r.failure_class, r.status, r.detail], [false, 'timeout', null, 'timed out twice (10 s)']);
  assert.equal(t.urls.length, 2, 'a second try after a timeout');
  assert.deepEqual(t.cfgs[0].timeout, 10_000);
  assert.deepEqual(hosts.records, [['geo.example', 'timeout', undefined]]);
  assert.deepEqual(hosts.ok, []);

  const again = new FakeHosts();
  const second = await probe('https://geo.example/print', [timeout(), ok(page())], { kind: 'url', hosts: again }).run;
  assert.equal(second.ok, true);
  assert.deepEqual(again.records, []);
  assert.deepEqual(again.ok, [['geo.example', 'page']]);
});

test('a connection reset is tried once more: reset then OK is OK, reset twice is a timeout failure recorded as a timeout', async () => {
  const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const hosts = new FakeHosts();
  assert.equal((await probe('https://e.example/a', [reset(), ok(page())], { kind: 'url', hosts }).run).ok, true);
  const t = probe('https://e.example/a', [reset()], { kind: 'url', hosts });
  const r = await t.run;
  assert.deepEqual([r.failure_class, r.detail, t.urls.length], ['timeout', 'connection cut twice', 2]);
  assert.deepEqual(hosts.records, [['e.example', 'timeout', undefined]]);
});

test('DNS and TLS errors are final (one try) and recorded; a feed also records its own address', async () => {
  const dns = new FakeHosts();
  const t = probe('https://nowhere.example/rss', [Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' })], { kind: 'rss', hosts: dns });
  const r = await t.run;
  assert.deepEqual([r.failure_class, t.urls.length], ['dns', 1]);
  assert.deepEqual(dns.records, [['nowhere.example', 'dns', undefined], ['nowhere.example/rss', 'dns', undefined]]);
  const tls = new FakeHosts();
  const r2 = await probe('https://bad.example/a', [Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })], { kind: 'url', hosts: tls }).run;
  assert.equal(r2.failure_class, 'tls');
  assert.deepEqual(tls.records, [['bad.example', 'tls', undefined]]);
});

test('the guard: a private address and a bad URL are invalid (not cached, not recorded); "does not resolve" is a recorded dns failure', async () => {
  const hosts = new FakeHosts();
  const store = new MemoryStore();
  for (const url of ['http://127.0.0.1/a', 'https://localhost/a', 'ftp://e.example/a', 'not a url', 'https://e.example:9999/a']) {
    const t = probe(url, [ok(page())], { kind: 'url', hosts, store });
    const r = await t.run;
    assert.deepEqual([r.ok, r.failure_class, r.status, t.urls.length], [false, 'invalid', null, 0], url);
  }
  const priv = await probe('https://internal.example/a', [ok(page())], { hosts, store, http: { lookup: async () => [{ address: '10.0.0.5', family: 4 }], get: async () => ok(page()) } }).run;
  assert.equal(priv.failure_class, 'invalid');
  assert.equal(store.puts, 0);
  assert.deepEqual(hosts.records, []);
  assert.deepEqual(hosts.ok, []);

  const empty = await probeSource('https://gone.example/a', { hosts, store, now: () => NOW, http: { lookup: async () => [], get: async () => ok(page()) }, kind: 'url' });
  assert.deepEqual([empty.failure_class, empty.detail], ['dns', 'the domain does not resolve (DNS)']);
  assert.deepEqual(hosts.records, [['gone.example', 'dns', undefined]]);
  assert.equal(store.puts, 1);
});

test('an unknown error (a redirect to a private address) is http with no status: cached, not recorded', async () => {
  const hosts = new FakeHosts();
  const store = new MemoryStore();
  const r = await probe('https://e.example/a', [{ status: 302, headers: { location: 'http://10.0.0.1/secret' }, data: '' }], {
    kind: 'url', hosts, store, http: { lookup: async (host) => [{ address: host.startsWith('10.') ? '10.0.0.1' : '93.184.216.34', family: 4 }] },
  }).run;
  assert.deepEqual([r.ok, r.failure_class, r.status], [false, 'http', null]);
  assert.ok(r.detail.length > 0 && r.detail.length <= 120);
  assert.deepEqual(hosts.records, []);
  assert.equal(store.puts, 1, 'cached');
});

test('the cache: inside 6 h the stored row is returned without a request; after 6 h, and with force, the address is read again', async () => {
  assert.equal(PROBE_CACHE_HOURS, 6);
  const store = new MemoryStore();
  const first = probe('https://e.example/rss', [ok(rss([{ title: 'A', date: h(1) }]), 'application/rss+xml')], { kind: 'rss', store });
  await first.run;
  assert.equal(store.puts, 1);
  const stored = store.rows.get('https://e.example/rss')!;
  assert.equal(stored.checked_at, NOW.toISOString());

  const at = (hours: number) => ({ store, now: () => new Date(NOW.getTime() + hours * 3_600_000), kind: 'rss' as const });
  const inside = probe('https://e.example/rss', [status(500)], at(5.9));
  const hit = await inside.run;
  assert.deepEqual([hit.cached, hit.ok, inside.urls.length], [true, true, 0]);
  const after = probe('https://e.example/rss', [status(500)], at(6.1));
  const fresh = await after.run;
  assert.deepEqual([fresh.cached, fresh.ok, fresh.failure_class, after.urls.length], [false, false, 'http', 1]);
  assert.equal(store.puts, 2);
  const forced = probe('https://e.example/rss', [ok(rss([{ title: 'B', date: h(0.5) }]), 'application/rss+xml')], { ...at(1), force: true });
  assert.equal((await forced.run).cached, false);
  assert.equal(forced.urls.length, 1);
  // maxAgeMs narrows or widens what counts as fresh.
  const wide = probe('https://e.example/rss', [status(500)], { ...at(20), maxAgeMs: 48 * 3_600_000 });
  assert.equal((await wide.run).cached, true);
});

test('cacheOnly returns the stored row or null and never makes a request', async () => {
  const store = new MemoryStore();
  const t0 = probe('https://e.example/a', [ok(page())], { kind: 'url', store });
  await t0.run;
  const later = (hours: number): ProbeOpts => ({ store, cacheOnly: true, now: () => new Date(NOW.getTime() + hours * 3_600_000) });
  const t1 = probe('https://e.example/a', [ok(page())], { ...later(1) });
  const hit = await t1.run;
  assert.equal(hit?.cached, true);
  assert.equal(t1.urls.length, 0);
  const t2 = probe('https://e.example/a', [ok(page())], { ...later(7) });
  assert.equal(await t2.run, null);
  assert.equal(t2.urls.length, 0);
  assert.equal(await probe('https://never.example/a', [ok(page())], later(0)).run, null);
  const bad = await probe('not a url', [ok(page())], later(0)).run;
  assert.equal(bad?.failure_class, 'invalid', 'the syntax check runs before the cache');
});

test('an active block answers without a request (blocked_until set, nothing stored); force reads anyway', async () => {
  const hosts = new FakeHosts();
  const until = new Date(NOW.getTime() + 20 * 3_600_000);
  const cases: Array<[HostFailureReason, string]> = [
    ['timeout', 'timeout'], ['unreachable', 'timeout'], ['refused', 'refused'], ['feed_refused', 'refused'], ['dns', 'dns'], ['tls', 'tls'],
    ['feed_missing', 'http'], ['feed_too_large', 'http'], ['feed_unparseable', 'empty'],
  ];
  for (const [reason, cls] of cases) {
    hosts.blocks.set('geo.example', { host: 'geo.example', reason, statusCode: reason === 'refused' ? 403 : null, until });
    const store = new MemoryStore();
    const t = probe('https://geo.example/a', [ok(page())], { kind: 'url', hosts, store });
    const r = await t.run;
    assert.deepEqual([r.failure_class, r.blocked_until, t.urls.length, store.puts], [cls, until.toISOString(), 0, 0], reason);
    assert.match(r.detail, /^blocked until 2026-10-30 08:00 UTC \(/);
  }
  assert.deepEqual(hosts.records, []);
  // A feed is checked on the host and on its own address; a block on the feed address alone answers too.
  hosts.blocks.clear();
  hosts.blocks.set('geo.example/rss', { host: 'geo.example/rss', reason: 'timeout', statusCode: null, until });
  hosts.checks.length = 0;
  const feed = probe('https://geo.example/rss', [ok(rss([{ title: 'A' }]))], { kind: 'rss', hosts });
  assert.equal((await feed.run).failure_class, 'timeout');
  assert.deepEqual(hosts.checks, ['geo.example|feed', 'geo.example/rss|feed']);
  const forced = probe('https://geo.example/rss', [ok(rss([{ title: 'A' }]), 'application/rss+xml')], { kind: 'rss', hosts, force: true });
  assert.equal((await forced.run).ok, true);
  assert.equal(forced.urls.length, 1);
});

test('A33 recording: an rss probe records network failures on the host and the feed key and nothing for a status; a url probe records a refusal', async () => {
  const rssHosts = new FakeHosts();
  await probe('https://e.example/rss', [status(403)], { kind: 'rss', hosts: rssHosts }).run;
  assert.deepEqual([rssHosts.records, rssHosts.ok], [[], []], 'a feed that answers 403 does not block the host\'s pages');
  await probe('https://e.example/rss', [timeout()], { kind: 'rss', hosts: rssHosts }).run;
  assert.deepEqual(rssHosts.records, [['e.example', 'timeout', undefined], ['e.example/rss', 'timeout', undefined]]);

  const urlHosts = new FakeHosts();
  await probe('https://e.example/p', [status(403)], { kind: 'url', hosts: urlHosts }).run;
  assert.deepEqual(urlHosts.records, [['e.example', 'refused', 403]]);
  await probe('https://e.example/p', [status(404)], { kind: 'url', hosts: urlHosts }).run;
  assert.equal(urlHosts.records.length, 1, 'a 404 is nobody\'s fault');
  for (const reason of urlHosts.records.concat(rssHosts.records).map((r) => r[1])) assert.ok(!reason.startsWith('feed_'), 'a probe never records a feed_* reason');
});

test('A33 reachability: any status under 400 calls succeeded, even on an empty or non-feed body; a feed uses "feed" on the host and its key', async () => {
  const empty = new FakeHosts();
  await probe('https://e.example/p', [ok('')], { kind: 'url', hosts: empty }).run;
  assert.deepEqual(empty.ok, [['e.example', 'page']]);
  const feed = new FakeHosts();
  await probe('https://e.example/rss', [ok(page())], { kind: 'rss', hosts: feed }).run;
  assert.deepEqual(feed.ok, [['e.example', 'feed'], ['e.example/rss', 'feed']], 'a page answered a feed card: the server still reached the host');
  const good = new FakeHosts();
  await probe('https://e.example/rss', [ok(rss([{ title: 'A' }]), 'application/rss+xml')], { kind: 'rss', hosts: good }).run;
  assert.deepEqual(good.ok, [['e.example', 'feed'], ['e.example/rss', 'feed']]);
  const none = new FakeHosts();
  await probe('https://e.example/p', [status(500)], { kind: 'url', hosts: none }).run;
  assert.deepEqual([none.ok, none.records], [[], []]);
});

test('via_proxy: a listed host is read through the proxy and says so; a failure reports it too', async () => {
  const env = (k: string) => ({ EGRESS_PROXY_URL: 'http://px.example:3128', EGRESS_PROXY_HOSTS: 'zakon.example' } as Record<string, string>)[k];
  const t = probe('https://zakon.example/print', [ok(page())], { kind: 'url', env });
  const r = await t.run;
  assert.equal(r.via_proxy, true);
  assert.ok(t.cfgs[0].proxy);
  const fail = await probe('https://zakon.example/print', [timeout()], { kind: 'url', env }).run;
  assert.deepEqual([fail.failure_class, fail.via_proxy], ['timeout', true]);
  assert.equal((await probe('https://open.example/print', [ok(page())], { kind: 'url', env }).run).via_proxy, false);
});

test('checkCandidate with a probe wired: the evidence is what the server saw, the error codes are the same', async () => {
  const run = async (kind: 'rss' | 'url', answer: ReturnType<typeof ok> | Error, url = 'https://e.example/x') => {
    const get = async () => { if (answer instanceof Error) throw answer; return answer; };
    const deps: CandidateDeps = { probe: (u, o) => probeSource(u, { ...o, http: { lookup, get }, now: () => NOW, retryMs: 0 }) };
    return checkCandidate({ kind, ref: url }, deps);
  };
  assert.deepEqual(await run('rss', ok(rss([{ title: 'A', date: h(3) }]), 'application/rss+xml')), { ok: true, evidence: '1 item, newest 3 h ago' });
  assert.deepEqual(await run('rss', ok(rss([]), 'application/rss+xml')), { ok: false, error: 'candidate_empty', details: 'the feed has no items' });
  const stale = await run('rss', ok(rss([{ title: 'A', date: h(24 * 40) }]), 'application/rss+xml'));
  assert.deepEqual(stale, { ok: false, error: 'candidate_stale', details: 'the newest item is 40 d old' });
  assert.deepEqual(await run('rss', status(404)), { ok: false, error: 'candidate_failed', details: 'HTTP 404' });
  assert.deepEqual(await run('rss', ok(page())), { ok: false, error: 'candidate_failed', details: 'not a feed' });
  const pageOk = await run('url', ok(page()));
  assert.ok(pageOk.ok && /^page, \d+ chars$/.test(pageOk.evidence));
  assert.deepEqual(await run('url', status(500)), { ok: false, error: 'candidate_http_error', details: 'status 500' });
  assert.deepEqual(await run('url', timeout()), { ok: false, error: 'candidate_failed', details: 'timed out twice (10 s)' });
  assert.deepEqual(await run('url', ok(page('', '<p>x</p>'))), { ok: false, error: 'candidate_empty', details: 'the page has 1 characters of text' });
});
