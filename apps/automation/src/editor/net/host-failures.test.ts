/**
 * Spec 040 FR-006: hosts that refused or failed a fetch are not asked again; 404s say not to guess; broken feeds answer.
 * Spec 070 FR-002: a connection reset is tried twice and then paused for an hour; a page's 403 does not stop the host's feed,
 * and a feed's own 403 / 404 stops that feed only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from '../tools/read-tools';
import { buildComposeTools } from '../tools/compose-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';
import { alternativeFor, classifyFetchError, feedKey, PgHostFailures, type HostBlock, type HostFailureReason, type HostFailures } from './host-failures';

class MemoryHosts implements HostFailures {
  rows = new Map<string, { reason: HostFailureReason; statusCode: number | null }>();
  async blocked(host: string, use: 'page' | 'feed'): Promise<HostBlock | null> {
    const r = this.rows.get(host);
    // The rule of PgHostFailures.blocked: a feed row stops feeds only, and a page's `refused` does not stop a feed.
    if (!r || (r.reason.startsWith('feed_') && use !== 'feed') || (r.reason === 'refused' && use === 'feed')) return null;
    return { host, reason: r.reason, statusCode: r.statusCode, until: new Date('2026-10-17T10:00:00Z') };
  }
  async record(host: string, reason: HostFailureReason, statusCode: number | null = null) { this.rows.set(host, { reason, statusCode }); }
}

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const card = { sources: [{ id: 'mtp', kind: 'rss', ref: 'https://www.marktechpost.com/feed/' }] };
const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan', extras: { card } };

function tools(get: (url: string) => Promise<any>) {
  const hosts = new MemoryHosts();
  const urls: string[] = [];
  const g = async (url: string) => { urls.push(url); return get(url); };
  const read = buildReadTools({ pool: { query: async () => ({ rows: [] }) } as any, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: { lookup, get: g }, hosts, retryMs: 0 });
  const compose = buildComposeTools({ http: { lookup, get: g }, hosts });
  const t = Object.fromEntries([...read, ...compose].map((x) => [x.name, x]));
  const call = (name: string, args: unknown) => t[name].execute(t[name].input.parse(args), ctx) as Promise<any>;
  return { call, hosts, urls };
}

test('a refusal marks the host: the next fetch of any page there is answered without a request; the card feed is the way out', async () => {
  const w = tools(async () => ({ status: 403, headers: {}, data: '' }));
  const r1 = await w.call('web_fetch', { url: 'https://www.marktechpost.com/2026/10/15/a/' });
  assert.equal(r1.error, 'http_error');
  assert.match(r1.details, /status 403/);
  assert.match(r1.alternative, /стрічки картки «mtp»/);
  assert.deepEqual(w.hosts.rows.get('marktechpost.com'), { reason: 'refused', statusCode: 403 });
  const r2 = await w.call('extract_images', { url: 'https://marktechpost.com/other' });
  assert.equal(r2.error, 'host_blocked');
  assert.match(r2.details, /^marktechpost\.com: сайт відмовляє в доступі \(status 403\)/);
  assert.equal(w.urls.length, 1, 'no second request');
});

test('404 says not to guess paths and blocks nothing', async () => {
  const w = tools(async () => ({ status: 404, headers: {}, data: '' }));
  const r = await w.call('web_fetch', { url: 'https://example.com/guessed/path' });
  assert.match(r.details, /^status 404: такої сторінки немає\. URL бери лише зі стрічки/);
  assert.equal(w.hosts.rows.size, 0);
});

test('DNS and TLS failures mark the host; other errors still throw; a reset is spec 070\'s (below)', async () => {
  const dns = tools(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }); });
  const r = await dns.call('web_fetch', { url: 'https://gone.example/a' });
  assert.equal(r.error, 'host_unreachable');
  assert.equal(dns.hosts.rows.get('gone.example')?.reason, 'dns');
  assert.equal(classifyFetchError({ code: 'CERT_HAS_EXPIRED' }), 'tls');
  assert.equal(classifyFetchError({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }), 'tls');
  assert.equal(classifyFetchError(new Error('timeout of 10000ms exceeded')), null);
  const other = tools(async () => { throw new Error('something else broke'); });
  await assert.rejects(other.call('web_fetch', { url: 'https://flaky.example/a' }), /something else broke/);
  assert.equal(other.hosts.rows.size, 0);
  assert.equal(other.urls.length, 1, 'only a reset is retried');
});

const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const tlsCut = () => Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
const RSS = '<rss version="2.0"><channel><title>T</title><item><title>A</title><link>https://example.com/a</link></item></channel></rss>';

test('spec 070: a reset on a page is tried once more; a second reset pauses the host for an hour as a timeout', async () => {
  for (const cut of [reset, tlsCut]) {
    const w = tools(async () => { throw cut(); });
    const r = await w.call('web_fetch', { url: 'https://zakon.example/laws/show/1' });
    assert.equal(r.error, 'host_unreachable');
    assert.match(r.details, /^zakon\.example: сайт обірвав з'єднання; година паузи/);
    assert.equal(w.urls.length, 2, 'one immediate retry');
    assert.deepEqual(w.hosts.rows.get('zakon.example'), { reason: 'timeout', statusCode: null }, 'recorded as a timeout: an hour, no strike');
    const again = await w.call('web_fetch', { url: 'https://zakon.example/laws/show/2' });
    assert.equal(again.error, 'host_blocked');
    assert.equal(w.urls.length, 2, 'the paused host is not asked');
  }
});

test('spec 070: a reset that the retry gets past leaves no mark', async () => {
  let calls = 0;
  const w = tools(async () => {
    if (++calls === 1) throw reset();
    return { status: 200, headers: { 'content-type': 'text/html' }, data: '<title>Law</title><p>Clause 1.1 text.</p>' };
  });
  const r = await w.call('web_fetch', { url: 'https://zakon.example/laws/show/1' });
  assert.equal(r.title, 'Law');
  assert.equal(w.urls.length, 2);
  assert.equal(w.hosts.rows.size, 0);
});

test('spec 070: fetch_feed retries a reset, then records it on the host as a timeout (not on the feed address)', async () => {
  const w = tools(async () => { throw reset(); });
  const r = await w.call('fetch_feed', { url: 'https://example.com/rss/news' });
  assert.equal(r.error, 'host_unreachable');
  assert.match(r.details, /example\.com: сайт обірвав з'єднання; година паузи/);
  assert.equal(w.urls.length, 2);
  assert.deepEqual([...w.hosts.rows.keys()], ['example.com']);
  assert.equal(w.hosts.rows.get('example.com')?.reason, 'timeout');
  let n = 0;
  const ok = tools(async () => { if (++n === 1) throw reset(); return { status: 200, headers: { 'content-type': 'application/rss+xml' }, data: RSS }; });
  assert.equal((await ok.call('fetch_feed', { url: 'https://example.com/rss/news' })).items.length, 1);
  assert.equal(ok.hosts.rows.size, 0);
});

test('spec 070: a 403 on a page does not stop the host\'s feed (and its timeout / DNS rows still do)', async () => {
  const w = tools(async (url) => (url.includes('/feed')
    ? { status: 200, headers: { 'content-type': 'application/rss+xml' }, data: RSS }
    : { status: 403, headers: {}, data: '' }));
  const page = await w.call('web_fetch', { url: 'https://example.com/2026/10/15/a/' });
  assert.equal(page.error, 'http_error');
  assert.equal(w.hosts.rows.get('example.com')?.reason, 'refused');
  const feed = await w.call('fetch_feed', { url: 'https://example.com/feed/' });
  assert.equal(feed.items.length, 1, 'the feed is read though the host refused a page');
  const again = await w.call('web_fetch', { url: 'https://example.com/other' });
  assert.equal(again.error, 'host_blocked', 'pages stay blocked');
  w.hosts.rows.set('example.com', { reason: 'dns', statusCode: null });
  assert.equal((await w.call('fetch_feed', { url: 'https://example.com/feed/' })).error, 'host_blocked');
  w.hosts.rows.set('example.com', { reason: 'timeout', statusCode: null });
  assert.equal((await w.call('fetch_feed', { url: 'https://example.com/feed/' })).error, 'host_blocked');
});

test('spec 070: a feed\'s own 403 / 429 is feed_refused on the feed address; the host\'s pages are still fetched', async () => {
  for (const status of [401, 403, 429, 451]) {
    const w = tools(async (url) => (url.includes('/feed') ? { status, headers: {}, data: '' } : { status: 200, headers: { 'content-type': 'text/html' }, data: '<title>P</title><p>page</p>' }));
    const r = await w.call('fetch_feed', { url: 'https://www.example.com/feed/' });
    assert.equal(r.error, 'http_error');
    assert.match(r.details, new RegExp(`^status ${status}: стрічка відмовляє в доступі`));
    assert.deepEqual([...w.hosts.rows.entries()], [['example.com/feed', { reason: 'feed_refused', statusCode: status }]], 'the feed address, not the host');
    const page = await w.call('web_fetch', { url: `https://example.com/2026/a${status}` });   // the shared document store keeps earlier pages
    assert.equal(page.title, 'P', 'pages of the host still fetch');
    const again = await w.call('fetch_feed', { url: 'https://example.com/feed' });
    assert.equal(again.error, 'host_blocked');
    assert.match(again.details, /^example\.com\/feed: стрічка відмовляє в доступі/);
    assert.equal(w.urls.length, 2, 'the second feed read made no request');
  }
});

test('spec 070: a feed that answers 400 / 404 / 410 is feed_missing: not read again today; a 500 is not recorded', async () => {
  for (const status of [400, 404, 410]) {
    const w = tools(async () => ({ status, headers: {}, data: '' }));
    const r = await w.call('fetch_feed', { url: 'https://dev.example/rss' });
    assert.equal(r.error, 'http_error');
    assert.match(r.details, new RegExp(`^status ${status}: `));
    assert.deepEqual([...w.hosts.rows.entries()], [['dev.example/rss', { reason: 'feed_missing', statusCode: status }]]);
    assert.equal((await w.call('fetch_feed', { url: 'https://dev.example/rss' })).error, 'host_blocked');
    assert.equal(w.urls.length, 1);
  }
  const broken = tools(async () => ({ status: 500, headers: {}, data: '' }));
  assert.equal((await broken.call('fetch_feed', { url: 'https://dev.example/rss' })).details, 'status 500');
  assert.equal(broken.hosts.rows.size, 0);
});

test('spec 070: a feed at the root of the site is stored as host/, so it never replaces the host\'s own refused row', async () => {
  assert.equal(feedKey('https://www.example.com/'), 'example.com/');
  assert.equal(feedKey('https://example.com'), 'example.com/');
  assert.equal(feedKey('https://example.com/?feed=rss'), 'example.com?feed=rss');
  assert.equal(feedKey('https://example.com/rss/'), 'example.com/rss');
  const w = tools(async (url) => (url === 'https://example.com/' ? { status: 403, headers: {}, data: '' } : { status: 200, headers: { 'content-type': 'text/html' }, data: '<title>P</title><p>x</p>' }));
  w.hosts.rows.set('example.com', { reason: 'refused', statusCode: 403 });
  const r = await w.call('fetch_feed', { url: 'https://example.com/' });
  assert.equal(r.error, 'http_error');
  assert.deepEqual(w.hosts.rows.get('example.com'), { reason: 'refused', statusCode: 403 }, 'the host row is untouched');
  assert.equal(w.hosts.rows.get('example.com/')?.reason, 'feed_refused');
});

test('a feed that does not parse: feed_unparseable, blocks fetch_feed only; gamerpower points to its API', async () => {
  const w = tools(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html><body>not a feed</body></html>' }));
  const r = await w.call('fetch_feed', { url: 'https://www.gamerpower.com/rss/giveaways' });
  assert.equal(r.error, 'feed_unparseable');
  assert.equal(w.hosts.rows.get('gamerpower.com/rss/giveaways')?.reason, 'feed_unparseable', 'spec 046: the address, not the host');
  const again = await w.call('fetch_feed', { url: 'https://www.gamerpower.com/rss/giveaways' });
  assert.equal(again.error, 'host_blocked');
  assert.match(again.alternative, /fetch_api з source gamerpower_giveaways/);
  assert.equal(w.urls.length, 1);
  // A page of the same host is still fetched.
  const page = await w.call('web_fetch', { url: 'https://www.gamerpower.com/x' });
  assert.equal(page.error, undefined);
  assert.equal(w.urls.length, 2);
});

test('alternativeFor: known APIs (also subdomains), then the card\'s feed on that host', () => {
  assert.match(alternativeFor('api.gamerpower.com')!, /gamerpower_giveaways/);
  assert.match(alternativeFor('marktechpost.com', card.sources as any)!, /«mtp»/);
  assert.equal(alternativeFor('example.com', card.sources as any), null);
});

test('PgHostFailures: blocked reads the live window; a feed reason does not block pages, a refused row does not block feeds; record upserts for 24 h', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let row: any = { host: 'x.com', reason: 'feed_unparseable', status_code: null, blocked_until: '2026-10-17T10:00:00Z' };
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: row ? [row] : [] }; } };
  const now = new Date('2026-10-16T10:00:00Z');
  const h = new PgHostFailures(pool as any, () => now);
  assert.equal(await h.blocked('x.com', 'page'), null);
  assert.equal((await h.blocked('x.com', 'feed'))?.reason, 'feed_unparseable');
  assert.match(calls[0].sql, /blocked_until > \$2/);
  // Spec 070: the host's page refusal is not the feed's; dns, tls and timeout rows block both.
  row = { host: 'x.com', reason: 'refused', status_code: 403, blocked_until: '2026-10-17T10:00:00Z' };
  assert.equal((await h.blocked('x.com', 'page'))?.reason, 'refused');
  assert.equal(await h.blocked('x.com', 'feed'), null);
  for (const reason of ['dns', 'tls', 'timeout']) {
    row = { host: 'x.com', reason, status_code: null, blocked_until: '2026-10-17T10:00:00Z' };
    assert.equal((await h.blocked('x.com', 'feed'))?.reason, reason, `${reason} blocks feeds`);
    assert.equal((await h.blocked('x.com', 'page'))?.reason, reason);
  }
  row = { host: 'x.com/feed', reason: 'feed_missing', status_code: 404, blocked_until: '2026-10-17T10:00:00Z' };
  assert.equal(await h.blocked('x.com/feed', 'page'), null);
  assert.equal((await h.blocked('x.com/feed', 'feed'))?.reason, 'feed_missing');
  row = null;
  await h.record('x.com', 'refused', 403);
  const ins = calls.at(-1)!;
  assert.match(ins.sql, /ON CONFLICT \(host\) DO UPDATE/);
  // [host, reason, status, at, until, strikes, in an active block, keep the old block] — the first strike is a day (spec 061 FR-004).
  assert.deepEqual(ins.params, ['x.com', 'refused', 403, now, new Date('2026-10-17T10:00:00Z'), 1, false, false]);
  // Spec 070: a feed's own refusal is a flat day on its address, whatever came before; the strikes of the row stay as they are.
  row = { reason: 'feed_refused', blocked_until: '2026-10-15T10:00:00Z', strikes: 0 };
  await h.record('x.com/feed', 'feed_refused', 403);
  assert.deepEqual(calls.at(-1)!.params, ['x.com/feed', 'feed_refused', 403, now, new Date('2026-10-17T10:00:00Z'), 0, false, false]);
  row = { reason: 'feed_missing', blocked_until: '2026-10-15T10:00:00Z', strikes: 0 };
  await h.record('x.com/feed', 'feed_missing', 404);
  assert.deepEqual(calls.at(-1)!.params, ['x.com/feed', 'feed_missing', 404, now, new Date('2026-10-17T10:00:00Z'), 0, false, false], 'a repeat the next day is a day again, not a longer block');
  // A failing read never stops a fetch.
  const broken = new PgHostFailures({ query: async () => { throw new Error('relation does not exist'); } } as any);
  assert.equal(await broken.blocked('x.com', 'page'), null);
});

test('046: a bad feed blocks only its address; an oversized feed is remembered, not thrown', async () => {
  let big = true;
  const w = tools(async (url) => {
    if (url.includes('/all')) { if (big) throw new Error('maxContentLength size of 2000000 exceeded'); }
    if (url.includes('/api')) return { status: 200, headers: { 'content-type': 'application/json' }, data: '{"a":1}' };
    return { status: 200, headers: { 'content-type': 'application/rss+xml' }, data: '<rss version="2.0"><channel><title>T</title><item><title>A</title><link>https://pcgamer.com/a</link></item></channel></rss>' };
  });
  assert.equal((await w.call('fetch_feed', { url: 'https://www.pcgamer.com/api/giveaways' })).error, 'feed_unparseable');
  const other = await w.call('fetch_feed', { url: 'https://www.pcgamer.com/rss/news/' });
  assert.equal(other.items.length, 1, 'another feed of the host still reads');
  const r = await w.call('fetch_feed', { url: 'https://www.pcgamer.com/rss/all' });
  assert.equal(r.error, 'feed_too_large');
  assert.equal(w.hosts.rows.get('pcgamer.com/rss/all')?.reason, 'feed_too_large');
  big = false;
  const n = w.urls.length;
  const again = await w.call('fetch_feed', { url: 'https://pcgamer.com/rss/all/' });
  assert.equal(again.error, 'host_blocked');
  assert.match(again.details, /більша за 2 МБ/);
  assert.equal(w.urls.length, n, 'no request for a remembered oversized feed');
});
