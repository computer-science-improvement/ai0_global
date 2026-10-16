/** Spec 040 FR-006: hosts that refused or failed a fetch are not asked again; 404s say not to guess; broken feeds answer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from '../tools/read-tools';
import { buildComposeTools } from '../tools/compose-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';
import { alternativeFor, classifyFetchError, PgHostFailures, type HostBlock, type HostFailureReason, type HostFailures } from './host-failures';

class MemoryHosts implements HostFailures {
  rows = new Map<string, { reason: HostFailureReason; statusCode: number | null }>();
  async blocked(host: string, use: 'page' | 'feed'): Promise<HostBlock | null> {
    const r = this.rows.get(host);
    if (!r || (r.reason.startsWith('feed_') && use !== 'feed')) return null;
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
  const read = buildReadTools({ pool: { query: async () => ({ rows: [] }) } as any, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: { lookup, get: g }, hosts });
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

test('DNS and TLS failures mark the host; other errors still throw', async () => {
  const dns = tools(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }); });
  const r = await dns.call('web_fetch', { url: 'https://gone.example/a' });
  assert.equal(r.error, 'host_unreachable');
  assert.equal(dns.hosts.rows.get('gone.example')?.reason, 'dns');
  assert.equal(classifyFetchError({ code: 'CERT_HAS_EXPIRED' }), 'tls');
  assert.equal(classifyFetchError({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }), 'tls');
  assert.equal(classifyFetchError(new Error('timeout of 10000ms exceeded')), null);
  const other = tools(async () => { throw new Error('socket hang up'); });
  await assert.rejects(other.call('web_fetch', { url: 'https://flaky.example/a' }), /socket hang up/);
  assert.equal(other.hosts.rows.size, 0);
});

test('a feed that does not parse: feed_unparseable, blocks fetch_feed only; gamerpower points to its API', async () => {
  const w = tools(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html><body>not a feed</body></html>' }));
  const r = await w.call('fetch_feed', { url: 'https://www.gamerpower.com/rss/giveaways' });
  assert.equal(r.error, 'feed_unparseable');
  assert.equal(w.hosts.rows.get('gamerpower.com')?.reason, 'feed_unparseable');
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

test('PgHostFailures: blocked reads the live window; a feed reason does not block pages; record upserts for 24 h', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let row: any = { host: 'x.com', reason: 'feed_unparseable', status_code: null, blocked_until: '2026-10-17T10:00:00Z' };
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: row ? [row] : [] }; } };
  const now = new Date('2026-10-16T10:00:00Z');
  const h = new PgHostFailures(pool as any, () => now);
  assert.equal(await h.blocked('x.com', 'page'), null);
  assert.equal((await h.blocked('x.com', 'feed'))?.reason, 'feed_unparseable');
  assert.match(calls[0].sql, /blocked_until > \$2/);
  row = null;
  await h.record('x.com', 'refused', 403);
  const ins = calls.at(-1)!;
  assert.match(ins.sql, /ON CONFLICT \(host\) DO UPDATE/);
  assert.deepEqual(ins.params, ['x.com', 'refused', 403, now, new Date('2026-10-17T10:00:00Z')]);
  // A failing read never stops a fetch.
  const broken = new PgHostFailures({ query: async () => { throw new Error('relation does not exist'); } } as any);
  assert.equal(await broken.blocked('x.com', 'page'), null);
});
