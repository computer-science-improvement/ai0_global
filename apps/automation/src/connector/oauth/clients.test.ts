import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClientRegistry, defaultMetadataFetcher, type MetadataFetcher } from './clients';
import { CIMD_URL_CODE, CIMD_URL_HOSTED, DCR_MAX_ACTIVE, DCR_PER_IP_PER_HOUR } from './constants';
import { OAuthError } from './errors';
import { MemoryOAuthStore } from './memory-store';
import { anyRedirectMatches, isAllowedRedirect, redirectMatches } from './redirect';
import { Clock } from './testing/fixtures';

// ── redirect matching ────────────────────────────────────────────────────────

test('redirect: exact string match', () => {
  assert.ok(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback'));
  assert.ok(!redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/'));
  assert.ok(!redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai:444/api/mcp/auth_callback'));
  assert.ok(!redirectMatches('https://claude.ai/cb', 'https://claude.ai/cb?x=1'));
});

test('redirect: loopback may differ only by port', () => {
  assert.ok(redirectMatches('http://localhost/callback', 'http://localhost:54321/callback'));
  assert.ok(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:7/callback'));
  assert.ok(redirectMatches('http://[::1]/callback', 'http://[::1]:9/callback'));
  assert.ok(!redirectMatches('http://localhost/callback', 'http://127.0.0.1:54321/callback'), 'host must match exactly');
  assert.ok(!redirectMatches('http://localhost/callback', 'http://localhost:54321/other'), 'path must match exactly');
  assert.ok(!redirectMatches('http://localhost/callback', 'https://localhost:54321/callback'), 'scheme must match');
  assert.ok(!redirectMatches('http://localhost/callback', 'http://localhost.evil.example/callback'));
  assert.ok(anyRedirectMatches(['http://localhost/callback', 'http://127.0.0.1/callback'], 'http://127.0.0.1:55555/callback'));
});

test('redirect allowlist: Claude callbacks and loopback only', () => {
  for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'http://localhost:8080/any', 'http://127.0.0.1/cb', 'http://[::1]:5/cb']) assert.ok(isAllowedRedirect(ok), ok);
  for (const bad of ['https://evil.example/cb', 'https://claude.ai/other', 'http://claude.ai/api/mcp/auth_callback', 'https://localhost/cb', 'javascript:alert(1)', 'http://localhost/cb#frag', 'http://user:pw@localhost/cb', 'not a url', '']) assert.ok(!isAllowedRedirect(bad), bad);
});

// ── DCR ──────────────────────────────────────────────────────────────────────

const dcrBody = (o: Record<string, unknown> = {}) => ({ client_name: 'C', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', ...o });
const reg = () => { const clock = new Clock(); const store = new MemoryOAuthStore(); return { clock, store, clients: new ClientRegistry(store, async () => { throw new Error('offline'); }, clock.now) }; };

test('DCR: registers a public client and echoes the metadata (201 shape)', async () => {
  const { clients, store } = reg();
  const r = await clients.register(dcrBody({ client_name: 'My Claude' }), '1.2.3.4');
  assert.match(String(r.client_id), /^ai0mcp_dcr_/);
  assert.equal(r.client_name, 'My Claude');
  assert.deepEqual(r.redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
  assert.equal(r.token_endpoint_auth_method, 'none');
  assert.equal(typeof r.client_id_issued_at, 'number');
  assert.equal((await store.getClient(r.client_id as string))?.kind, 'dcr');
});

test('DCR: redirect allowlist and auth method are enforced', async () => {
  const { clients } = reg();
  await assert.rejects(clients.register(dcrBody({ redirect_uris: ['https://evil.example/cb'] }), null), (e: any) => e instanceof OAuthError && e.code === 'invalid_redirect_uri');
  await assert.rejects(clients.register(dcrBody({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'] }), null), (e: any) => e.code === 'invalid_redirect_uri');
  await assert.rejects(clients.register(dcrBody({ redirect_uris: [] }), null), (e: any) => e.code === 'invalid_redirect_uri');
  await assert.rejects(clients.register(dcrBody({ token_endpoint_auth_method: 'client_secret_basic' }), null), (e: any) => e.code === 'invalid_client_metadata');
  await assert.rejects(clients.register(dcrBody({ grant_types: ['password'] }), null), (e: any) => e.code === 'invalid_client_metadata');
  await assert.rejects(clients.register('x', null), (e: any) => e.code === 'invalid_client_metadata');
  const ok = await clients.register(dcrBody({ redirect_uris: ['http://localhost:9999/cb', 'http://127.0.0.1/cb'] }), null);
  assert.equal((ok.redirect_uris as string[]).length, 2);
});

test('DCR: 20 registrations per IP per hour, then it frees up', async () => {
  const { clients, clock } = reg();
  for (let i = 0; i < DCR_PER_IP_PER_HOUR; i++) await clients.register(dcrBody(), '5.5.5.5');
  await assert.rejects(clients.register(dcrBody(), '5.5.5.5'), (e: any) => e.status === 429);
  await clients.register(dcrBody(), '6.6.6.6'); // another IP is unaffected
  clock.advance(3600 * 1000 + 1);
  await clients.register(dcrBody(), '5.5.5.5');
});

test('DCR: at most 100 active clients', async () => {
  const { clients, store } = reg();
  for (let i = 0; i < DCR_MAX_ACTIVE; i++) await store.upsertClient({ clientId: `c${i}`, kind: 'dcr', name: 'x', redirectUris: [] }, new Date());
  await assert.rejects(clients.register(dcrBody(), '7.7.7.7'), (e: any) => e.status === 429);
});

test('DCR clients resolve by id; unknown ids and revoked clients do not', async () => {
  const { clients, store } = reg();
  const r = await clients.register(dcrBody(), null);
  assert.equal((await clients.resolve(r.client_id as string))?.name, 'C');
  assert.equal(await clients.resolve('nope'), null);
  const row = await store.getClient(r.client_id as string);
  await store.revokeClient(row!.id, new Date());
  assert.equal(await clients.resolve(r.client_id as string), null);
});

// ── CIMD ─────────────────────────────────────────────────────────────────────

const doc = (o: Record<string, unknown> = {}) => JSON.stringify({ client_id: CIMD_URL_HOSTED, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], ...o });
const cimdRegistry = (fetcher: MetadataFetcher) => { const clock = new Clock(); const store = new MemoryOAuthStore(); return { clock, store, clients: new ClientRegistry(store, fetcher, clock.now) }; };

test('CIMD: a valid document is accepted and recorded', async () => {
  const { clients, store } = cimdRegistry(async () => ({ status: 200, text: doc({ client_name: 'Claude Hosted' }) }));
  const c = await clients.resolve(CIMD_URL_HOSTED);
  assert.deepEqual({ kind: c?.kind, name: c?.name, uris: c?.redirectUris }, { kind: 'cimd', name: 'Claude Hosted', uris: ['https://claude.ai/api/mcp/auth_callback'] });
  assert.equal((await store.getClient(CIMD_URL_HOSTED))?.kind, 'cimd');
});

test('CIMD: client_id that does not equal the URL is refused (no pinned fallback)', async () => {
  const { clients } = cimdRegistry(async () => ({ status: 200, text: doc({ client_id: 'https://evil.example/meta' }) }));
  await assert.rejects(clients.resolve(CIMD_URL_HOSTED), (e: any) => e instanceof OAuthError && e.code === 'unauthorized_client');
});

test('CIMD: redirect_uris outside the allowlist are dropped; none left means refused', async () => {
  const mixed = cimdRegistry(async () => ({ status: 200, text: doc({ redirect_uris: ['https://evil.example/cb', 'https://claude.com/api/mcp/auth_callback'] }) }));
  assert.deepEqual((await mixed.clients.resolve(CIMD_URL_HOSTED))?.redirectUris, ['https://claude.com/api/mcp/auth_callback']);
  const none = cimdRegistry(async () => ({ status: 200, text: doc({ redirect_uris: ['https://evil.example/cb'] }) }));
  await assert.rejects(none.clients.resolve(CIMD_URL_HOSTED), (e: any) => e.code === 'unauthorized_client');
});

test('CIMD: fetch failure (network, 500, bad JSON) falls back to the pinned copy', async () => {
  for (const f of [async () => { throw new Error('timeout'); }, async () => ({ status: 500, text: '' }), async () => ({ status: 200, text: '<html>' })] as MetadataFetcher[]) {
    const { clients } = cimdRegistry(f);
    const hosted = await clients.resolve(CIMD_URL_HOSTED);
    assert.deepEqual(hosted?.redirectUris, ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']);
    const code = await clients.resolve(CIMD_URL_CODE);
    assert.deepEqual(code?.redirectUris, ['http://localhost/callback', 'http://127.0.0.1/callback']);
    assert.equal(code?.name, 'Claude Code');
  }
});

test('CIMD: any other URL client is unauthorized_client, and is never fetched', async () => {
  let fetched = 0;
  const { clients } = cimdRegistry(async () => { fetched++; return { status: 200, text: '{}' }; });
  await assert.rejects(clients.resolve('https://evil.example/client.json'), (e: any) => e.code === 'unauthorized_client');
  await assert.rejects(clients.resolve('https://claude.ai/oauth/other'), (e: any) => e.code === 'unauthorized_client');
  assert.equal(fetched, 0);
});

test('CIMD: the document is cached for 24 hours', async () => {
  let fetched = 0;
  const { clients, clock } = cimdRegistry(async () => { fetched++; return { status: 200, text: doc() }; });
  await clients.resolve(CIMD_URL_HOSTED);
  await clients.resolve(CIMD_URL_HOSTED);
  assert.equal(fetched, 1);
  clock.advance(24 * 3600 * 1000 + 1);
  await clients.resolve(CIMD_URL_HOSTED);
  assert.equal(fetched, 2);
});

test('CIMD: a client removed in Settings can connect again (grants were revoked, the client is not barred)', async () => {
  const { clients, store } = cimdRegistry(async () => { throw new Error('offline'); });
  await clients.resolve(CIMD_URL_HOSTED);
  const row = await store.getClient(CIMD_URL_HOSTED);
  await store.revokeClient(row!.id, new Date());
  assert.ok(await clients.resolve(CIMD_URL_HOSTED));
  assert.equal((await store.getClient(CIMD_URL_HOSTED))?.revokedAt, null);
});

test('default fetcher: reads a document, treats a redirect as failure, caps the size at 64 KB', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/ok') { res.setHeader('content-type', 'application/json'); res.end('{"a":1}'); }
    else if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/x'); res.end(); }
    else if (req.url === '/big') { res.end('x'.repeat(70 * 1024)); }
    else { res.statusCode = 404; res.end('no'); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await defaultMetadataFetcher(`${base}/ok`), { status: 200, text: '{"a":1}' });
    assert.equal((await defaultMetadataFetcher(`${base}/missing`)).status, 404);
    await assert.rejects(defaultMetadataFetcher(`${base}/redirect`), /redirect/);
    await assert.rejects(defaultMetadataFetcher(`${base}/big`), /too large/);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});
