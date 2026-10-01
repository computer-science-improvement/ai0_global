import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeGet } from './safe-http';

const publicLookup = async (host: string) => [{ address: host.startsWith('internal') ? '10.0.0.1' : '93.184.216.34', family: 4 }];

test('returns body for a public URL with redirects disabled at axios level', async () => {
  const cfgs: any[] = [];
  const res = await safeGet('https://example.com/a', {
    lookup: publicLookup,
    get: async (_u, cfg) => { cfgs.push(cfg); return { status: 200, headers: { 'content-type': 'text/html' }, data: '<p>hi</p>' }; },
  });
  assert.equal(res.body, '<p>hi</p>');
  assert.equal(cfgs[0].maxRedirects, 0);
  assert.equal(cfgs[0].maxContentLength, 2_000_000);
});

test('re-validates each redirect hop', async () => {
  const urls: string[] = [];
  await assert.rejects(safeGet('https://example.com/a', {
    lookup: publicLookup,
    get: async (u) => { urls.push(u); return { status: 302, headers: { location: 'http://internal.example/secret' }, data: '' }; },
  }), /private/);
  assert.equal(urls.length, 1);
});

test('follows relative redirect then succeeds', async () => {
  const urls: string[] = [];
  const res = await safeGet('https://example.com/a', {
    lookup: publicLookup,
    get: async (u) => { urls.push(u); return urls.length === 1 ? { status: 301, headers: { location: '/b' }, data: '' } : { status: 200, headers: {}, data: 'ok' }; },
  });
  assert.equal(res.url, 'https://example.com/b');
  assert.equal(res.body, 'ok');
});

test('too many redirects', async () => {
  await assert.rejects(safeGet('https://example.com/', {
    lookup: publicLookup,
    get: async () => ({ status: 302, headers: { location: '/again' }, data: '' }),
  }), /too many redirects/);
});
