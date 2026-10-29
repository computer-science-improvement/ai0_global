/**
 * Spec 076 FR-003 (A29): the per-host egress proxy of safe-http. A listed host (or a subdomain of one) is read through
 * EGRESS_PROXY_URL; every other request carries no `proxy` key at all, so HTTPS_PROXY / NO_PROXY keep working for it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { egressProxyConfigured, egressProxyFor, safeGet, safeGetBytes } from './safe-http';
import { settingDef, normalizeSetting } from '../../settings/catalog';

const publicLookup = async (host: string) => [{ address: host.startsWith('internal') ? '10.0.0.1' : '93.184.216.34', family: 4 }];
const envOf = (o: Record<string, string>) => (k: string) => o[k];
const PROXY = 'http://user:p%40ss@proxy.example:3128';
const ok = { status: 200, headers: { 'content-type': 'text/html' }, data: '<p>hi</p>' };

test('egressProxyFor: a listed host, its subdomains, www. and case; an unlisted host and an empty list go direct', () => {
  const env = envOf({ EGRESS_PROXY_URL: PROXY, EGRESS_PROXY_HOSTS: 'Zakon.Rada.gov.ua, www.example.org' });
  assert.deepEqual(egressProxyFor('zakon.rada.gov.ua', env), { protocol: 'http', host: 'proxy.example', port: 3128, auth: { username: 'user', password: 'p@ss' } });
  assert.ok(egressProxyFor('ZAKON.rada.gov.ua', env), 'case is ignored');
  assert.ok(egressProxyFor('www.zakon.rada.gov.ua', env), 'www. is ignored');
  assert.ok(egressProxyFor('sub.zakon.rada.gov.ua', env), 'a subdomain of a listed host');
  assert.ok(egressProxyFor('example.org', env), 'a listed www. host matches the bare host');
  assert.equal(egressProxyFor('rada.gov.ua', env), null, 'the parent of a listed host is not listed');
  assert.equal(egressProxyFor('evilzakon.rada.gov.ua', env), null, 'a suffix that is not a subdomain');
  assert.equal(egressProxyFor('other.example', env), null);
  assert.equal(egressProxyFor('zakon.rada.gov.ua', envOf({ EGRESS_PROXY_URL: PROXY, EGRESS_PROXY_HOSTS: '' })), null, 'an empty list');
  assert.equal(egressProxyFor('zakon.rada.gov.ua', envOf({ EGRESS_PROXY_HOSTS: 'zakon.rada.gov.ua' })), null, 'no proxy URL');
  // An https proxy keeps its protocol and default port; credentials are optional.
  assert.deepEqual(egressProxyFor('a.example', envOf({ EGRESS_PROXY_URL: 'https://px.example', EGRESS_PROXY_HOSTS: 'a.example' })), { protocol: 'https', host: 'px.example', port: 443 });
});

test('egressProxyConfigured: true only for a usable http(s) proxy URL', () => {
  assert.equal(egressProxyConfigured(envOf({ EGRESS_PROXY_URL: PROXY })), true);
  assert.equal(egressProxyConfigured(envOf({ EGRESS_PROXY_URL: 'https://px.example:8443' })), true);
  for (const bad of ['', '   ', 'socks5://px.example:1080', 'not a url', 'px.example:3128', 'ftp://px.example']) {
    assert.equal(egressProxyConfigured(envOf({ EGRESS_PROXY_URL: bad })), false, JSON.stringify(bad));
  }
  assert.equal(egressProxyConfigured(envOf({})), false);
});

test('a listed host carries proxy and via_proxy; an unlisted host carries no proxy key and via_proxy false', async () => {
  const env = envOf({ EGRESS_PROXY_URL: PROXY, EGRESS_PROXY_HOSTS: 'listed.example' });
  const cfgs: Array<Record<string, unknown>> = [];
  const get = async (_u: string, cfg: Record<string, unknown>) => { cfgs.push(cfg); return ok; };
  const a = await safeGet('https://www.listed.example/a', { lookup: publicLookup, get, env });
  assert.equal(a.via_proxy, true);
  assert.deepEqual(cfgs[0].proxy, { protocol: 'http', host: 'proxy.example', port: 3128, auth: { username: 'user', password: 'p@ss' } });
  const b = await safeGet('https://unlisted.example/a', { lookup: publicLookup, get, env });
  assert.equal(b.via_proxy, false);
  assert.equal('proxy' in cfgs[1], false, 'the key is left out, never `proxy: false`');
  const bytes = await safeGetBytes('https://listed.example/i.png', { lookup: publicLookup, env, get: async (_u, cfg) => { cfgs.push(cfg); return { status: 200, headers: {}, data: new Uint8Array([1]).buffer }; } });
  assert.equal(bytes.via_proxy, true);
  assert.ok(cfgs[2].proxy);
});

test('the settings are read on every request: a changed value takes effect on the next call', async () => {
  const live: Record<string, string> = { EGRESS_PROXY_URL: PROXY, EGRESS_PROXY_HOSTS: 'one.example' };
  const env = (k: string) => live[k];
  const seen: boolean[] = [];
  const get = async (_u: string, cfg: Record<string, unknown>) => { seen.push('proxy' in cfg); return ok; };
  await safeGet('https://two.example/', { lookup: publicLookup, get, env });
  live.EGRESS_PROXY_HOSTS = 'one.example,two.example';
  await safeGet('https://two.example/', { lookup: publicLookup, get, env });
  live.EGRESS_PROXY_URL = '';
  await safeGet('https://two.example/', { lookup: publicLookup, get, env });
  assert.deepEqual(seen, [false, true, false]);
});

test('a malformed proxy URL (socks5 included) means a direct request, with one warning that holds no part of the value', async () => {
  const warn = mock.method(Logger.prototype, 'warn', () => undefined);
  try {
    const secret = 'socks5://leaky-user:leaky-pass@px.example:1080';
    const env = envOf({ EGRESS_PROXY_URL: secret, EGRESS_PROXY_HOSTS: 'listed.example' });
    const cfgs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
      const r = await safeGet('https://listed.example/a', { lookup: publicLookup, env, get: async (_u, cfg) => { cfgs.push(cfg); return ok; } });
      assert.equal(r.via_proxy, false);
    }
    assert.ok(cfgs.every((c) => !('proxy' in c)), 'direct');
    assert.equal(warn.mock.callCount(), 1, 'one warning per distinct value');
    const text = String(warn.mock.calls[0].arguments[0]);
    for (const part of ['leaky', 'socks5', 'px.example', '1080']) assert.ok(!text.includes(part), `the warning shows ${part}`);
    // Another malformed value warns once more; an unlisted host never warns.
    const junk = envOf({ EGRESS_PROXY_URL: 'junk value', EGRESS_PROXY_HOSTS: 'listed.example' });
    assert.equal(egressProxyFor('listed.example', junk), null);
    assert.equal(egressProxyFor('listed.example', junk), null);
    assert.equal(egressProxyFor('other.example', envOf({ EGRESS_PROXY_URL: 'another junk', EGRESS_PROXY_HOSTS: 'listed.example' })), null);
    assert.equal(warn.mock.callCount(), 2);
  } finally {
    warn.mock.restore();
  }
});

test('a redirect picks its proxy per hop: a listed host to an unlisted one goes direct, and back', async () => {
  const env = envOf({ EGRESS_PROXY_URL: PROXY, EGRESS_PROXY_HOSTS: 'listed.example' });
  const hops: Array<[string, boolean]> = [];
  const to = async (location: string, final: string, first: string) => {
    hops.length = 0;
    const res = await safeGet(first, {
      lookup: publicLookup, env,
      get: async (u, cfg) => { hops.push([new URL(u).hostname, 'proxy' in cfg]); return hops.length === 1 ? { status: 302, headers: { location }, data: '' } : { ...ok, headers: { 'content-type': 'text/html' } }; },
    });
    assert.equal(res.url, final);
    return res;
  };
  const out = await to('https://open.example/x', 'https://open.example/x', 'https://listed.example/a');
  assert.deepEqual(hops, [['listed.example', true], ['open.example', false]]);
  assert.equal(out.via_proxy, false, 'via_proxy describes the final request');
  const back = await to('https://listed.example/y', 'https://listed.example/y', 'https://open.example/a');
  assert.deepEqual(hops, [['open.example', false], ['listed.example', true]]);
  assert.equal(back.via_proxy, true);
});

test('SSRF still refuses a private target with the proxy on, before any request', async () => {
  const env = envOf({ EGRESS_PROXY_URL: PROXY, EGRESS_PROXY_HOSTS: 'internal.example,127.0.0.1' });
  let calls = 0;
  const get = async () => { calls++; return ok; };
  await assert.rejects(safeGet('https://internal.example/a', { lookup: publicLookup, get, env }), /private/);
  await assert.rejects(safeGet('http://127.0.0.1/a', { lookup: publicLookup, get, env }), /private/);
  // A redirect from a listed public host to a private one is refused as well.
  await assert.rejects(safeGet('https://listed.example/a', {
    lookup: publicLookup, env: envOf({ EGRESS_PROXY_URL: PROXY, EGRESS_PROXY_HOSTS: 'listed.example' }),
    get: async () => { calls++; return { status: 302, headers: { location: 'http://internal.example/secret' }, data: '' }; },
  }), /private/);
  assert.equal(calls, 1, 'only the public first hop was requested');
});

test('the two settings are in the catalog: live, a secret and a host list, with the proxy help ending in the scheme rule', () => {
  const url = settingDef('EGRESS_PROXY_URL')!;
  const hosts = settingDef('EGRESS_PROXY_HOSTS')!;
  assert.deepEqual([url.type, url.apply, url.default], ['secret', 'live', '']);
  assert.deepEqual([hosts.type, hosts.apply, hosts.default], ['list', 'live', '']);
  assert.match(url.help, /http or https proxy only\.$/);
  assert.deepEqual(normalizeSetting(hosts, 'Zakon.rada.gov.ua, example.org'), { value: 'Zakon.rada.gov.ua,example.org' });
  assert.ok('error' in normalizeSetting(hosts, 'bad host!'));
  assert.deepEqual(normalizeSetting(url, 'http://u:p@px.example:3128'), { value: 'http://u:p@px.example:3128' });
});
