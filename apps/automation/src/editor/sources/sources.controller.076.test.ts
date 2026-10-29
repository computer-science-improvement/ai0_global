import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { SourcesController } from './sources.controller';
import { applyHostProxyAdd, applySourceDrop } from './source-fixes';
import { sharedDocStore } from '../docs/doc-store';
import type { ProbeResult } from './probe';

/** Spec 076 FR-005 / FR-008 / A30: the endpoints behind "Test from server", "Upload the page", "Remove" and "Route via proxy". */

const FEED = { id: 'news', kind: 'rss', ref: 'https://example.com/feed.xml' };
const PAGE = { id: 'blog', kind: 'url', ref: 'https://blog.example.org/posts' };

interface Rig {
  ctl:     SourcesController;
  saved:   Array<[string, any]>;
  set:     Array<[string, string]>;
  probes:  Array<[string, any]>;
}

function rig(o: { cards?: Record<string, any>; rows?: any[]; upsertThrows?: Error } = {}): Rig {
  const saved: Rig['saved'] = [];
  const set: Rig['set'] = [];
  const probes: Rig['probes'] = [];
  const pool = { query: async (sql: string) => (/data_imports/.test(sql) ? { rows: o.rows ?? [] } : { rows: [] }) } as any;
  const ops = {
    getChannel: async (k: string) => { const c = o.cards?.[k]; if (!c) throw new NotFoundException({ error: 'channel_not_found', channel: k }); return c; },
    upsertChannel: async (k: string, body: unknown) => { if (o.upsertThrows) throw o.upsertThrows; saved.push([k, body]); return { ok: true }; },
  } as any;
  const settings = {
    setValue: async (k: string, v: string) => { set.push([k, v]); process.env[k] = v; return { key: k }; },
  } as any;
  const config = { get: () => undefined } as any;
  const ctl = new SourcesController(pool, ops, settings, config);
  (ctl as any).prober = async (url: string, opts: any): Promise<ProbeResult> => {
    probes.push([url, opts]);
    return { ok: true, failure_class: null, status: 200, kind: 'rss', feed_url: url, items: 5, newest_at: null, sample_titles: [], checked_at: new Date().toISOString(), via_proxy: !!process.env.EGRESS_PROXY_HOSTS, url, detail: '5 items', ms: 30, cached: false, blocked_until: null };
  };
  return { ctl, saved, set, probes };
}

/** Runs `fn` with these process.env values (undefined = unset) and restores them. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const fails = async (fn: () => Promise<unknown> | unknown): Promise<{ status: number; body: any }> => {
  try { await fn(); } catch (err: any) { return { status: err.getStatus(), body: err.getResponse() }; }
  assert.fail('expected the call to be refused');
};

// ── probe ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('probe: a forced read through the prober, with the kind when the panel gives one', async () => {
  const { ctl, probes } = rig();
  const r: any = await ctl.probe({ url: FEED.ref, kind: 'rss' });
  assert.equal(r.ok, true);
  assert.deepEqual(probes, [[FEED.ref, { force: true, kind: 'rss' }]]);
  await ctl.probe({ url: PAGE.ref });
  assert.deepEqual(probes[1], [PAGE.ref, { force: true }]);
  assert.equal((await fails(() => ctl.probe({ url: '' }))).status, 400);
  assert.equal((await fails(() => ctl.probe({ url: FEED.ref, kind: 'library' }))).body.error, 'invalid_body');
});

test('probe: an address that is not http(s) is answered as invalid, with no request', async () => {
  // The real prober, not the rig's: an address the SSRF guard or the syntax check refuses never reaches the network.
  const r: any = await new SourcesController({ query: async () => ({ rows: [] }) } as any, {} as any, {} as any, { get: () => undefined } as any).probe({ url: 'file:///etc/passwd' });
  assert.equal(r.ok, false);
  assert.equal(r.failure_class, 'invalid');
});

// ── upload ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('upload: a saved page is kept and the doc id comes back; bad bodies and JSON are refused', async () => {
  const { ctl } = rig();
  const page = '<html><head><title>Rules</title></head><body><h1>Rules</h1><p>1.1. First clause of the rules.</p><p>1.2. Second clause of the rules.</p></body></html>';
  const r: any = await ctl.upload({ url: 'https://rules.example.test/print', content: page });
  assert.equal(r.kind, 'html');
  assert.equal(r.title, 'Rules');
  assert.equal(sharedDocStore().get(r.doc_id)?.origin, 'upload');
  assert.equal((await fails(() => ctl.upload({ url: 'ftp://x.example/a', content: 'x' }))).body.error, 'invalid_body');
  assert.equal((await fails(() => ctl.upload({ content: 'x' }))).status, 400);
  const json = await fails(() => ctl.upload({ url: 'https://api.example.test/items', content: '{"items":[{"a":1}]}', content_type: 'text/plain' }));
  assert.deepEqual([json.status, json.body.error], [400, 'unsupported_content']);
  const empty = await fails(() => ctl.upload({ url: 'https://blank.example.test/', content: '<html><body> </body></html>' }));
  assert.equal(empty.body.error, 'empty_page');
});

test('upload with a dataset: no list import is 404, another address is 409', async () => {
  const { ctl } = rig();
  const none = await fails(() => ctl.upload({ url: 'https://rules.example.test/print', content: '<p>text of the page</p>', dataset: 'pdr_rules' }));
  assert.deepEqual([none.status, none.body.error], [404, 'no_list_import']);
  const withImport = rig({ rows: [{ import_id: 'i1', dataset: 'pdr_rules', options: { url: 'https://rules.example.test/print', auto_resync: true } }] });
  const mismatch = await fails(() => withImport.ctl.upload({ url: 'https://other.example.test/print', content: '<p>text of the page</p>', dataset: 'pdr_rules' }));
  assert.deepEqual([mismatch.status, mismatch.body.error], [409, 'url_mismatch']);
});

// ── drop ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('drop sends the card save the array without that source', async () => {
  const { ctl, saved } = rig({ cards: { '@chan': { channelKey: '@chan', sources: [FEED, PAGE] } } });
  const r: any = await ctl.drop({ channel: '@chan', sourceId: 'news' });
  assert.equal(r.ok, true);
  assert.match(r.applied, /Removed source “news”/);
  assert.deepEqual(saved, [['@chan', { sources: [PAGE] }]]);
});

test('drop of an unknown source or channel is a 404', async () => {
  const { ctl, saved } = rig({ cards: { '@chan': { channelKey: '@chan', sources: [FEED] } } });
  const nosource = await fails(() => ctl.drop({ channel: '@chan', sourceId: 'ghost' }));
  assert.deepEqual([nosource.status, nosource.body.error], [404, 'source_not_found']);
  const nochannel = await fails(() => ctl.drop({ channel: '@nobody', sourceId: 'news' }));
  assert.deepEqual([nochannel.status, nochannel.body.error], [404, 'channel_not_found']);
  assert.equal((await fails(() => ctl.drop({ channel: '@chan' }))).body.error, 'invalid_body');
  assert.deepEqual(saved, [], 'nothing was saved');
});

test('drop: a refused card save is a 400 with the reason', async () => {
  const { ctl } = rig({ cards: { '@chan': { channelKey: '@chan', sources: [FEED] } }, upsertThrows: new Error('card is invalid') });
  const r = await fails(() => ctl.drop({ channel: '@chan', sourceId: 'news' }));
  assert.deepEqual([r.status, r.body.error], [400, 'card is invalid']);
});

// ── proxy-host ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('proxy-host: 409 proxy_not_configured without a valid proxy URL, and nothing is written', async () => {
  for (const proxy of [undefined, '', 'not a url', 'socks5://proxy.example:1080']) {
    await withEnv({ EGRESS_PROXY_URL: proxy, EGRESS_PROXY_HOSTS: undefined }, async () => {
      const { ctl, set, probes } = rig();
      const r = await fails(() => ctl.proxyHost({ host: 'example.com', url: FEED.ref }));
      assert.deepEqual([r.status, r.body.error], [409, 'proxy_not_configured'], String(proxy));
      assert.deepEqual(set, []);
      assert.deepEqual(probes, []);
    });
  }
});

test('proxy-host adds the host to EGRESS_PROXY_HOSTS through the settings service, then probes the page once, forced', async () => {
  await withEnv({ EGRESS_PROXY_URL: 'http://user:pass@proxy.example:3128', EGRESS_PROXY_HOSTS: 'old.example' }, async () => {
    const { ctl, set, probes } = rig();
    const r: any = await ctl.proxyHost({ host: 'WWW.Example.com', url: FEED.ref, kind: 'rss' });
    assert.deepEqual(set, [['EGRESS_PROXY_HOSTS', 'old.example,example.com']]);
    assert.deepEqual(r.hosts, ['old.example', 'example.com']);
    assert.match(r.applied, /example\.com is now read through the proxy/);
    assert.equal(r.probe.ok, true);
    assert.deepEqual(probes, [[FEED.ref, { force: true, kind: 'rss' }]]);
    assert.ok(!JSON.stringify(r).includes('pass'), 'the proxy credentials never leave the server');
  });
});

test('proxy-host without a url only adds the host; a host that is already listed is left as it is; a bad host is a 400', async () => {
  await withEnv({ EGRESS_PROXY_URL: 'https://proxy.example:8443', EGRESS_PROXY_HOSTS: 'example.com' }, async () => {
    const { ctl, set, probes } = rig();
    const same: any = await ctl.proxyHost({ host: 'feeds.example.com' });
    assert.deepEqual(set, [], 'a subdomain of a listed host is covered');
    assert.equal(same.probe, null);
    assert.deepEqual(probes, []);
    const bad = await fails(() => ctl.proxyHost({ host: 'not a host!' }));
    assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_host']);
    assert.equal((await fails(() => ctl.proxyHost({}))).body.error, 'invalid_body');
  });
});

// ── the two fixes, without the controller ──────────────────────────────────────────────────────────────────────────

test('applySourceDrop and applyHostProxyAdd return the contract\'s FixResult', async () => {
  const drop = await applySourceDrop({ card: async () => ({ sources: [FEED as any] }), upsert: async () => ({}) }, { kind: 'source_drop', channel: '@c', sourceId: 'news' });
  assert.deepEqual(Object.keys(drop).sort(), ['applied', 'ok']);
  const add = await applyHostProxyAdd({ env: () => undefined, setHosts: async () => ({}) }, { kind: 'host_proxy_add', host: 'x.example' });
  assert.deepEqual(add, { ok: false, error: 'proxy_not_configured' });
  const failing = await applyHostProxyAdd(
    { env: (k) => (k === 'EGRESS_PROXY_URL' ? 'http://p.example:80' : undefined), setHosts: async () => { throw new Error('bad item'); } },
    { kind: 'host_proxy_add', host: 'x.example' });
  assert.deepEqual(failing, { ok: false, error: 'bad item' });
});
