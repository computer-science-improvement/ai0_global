/**
 * In-process HTTP e2e of the whole connector dance on a real listening Nest app (port 0, 127.0.0.1 only):
 * discovery → register (DCR) and CIMD (fake fetcher) → authorize → consent (fake session) → token → initialize and
 * tools/list through /api/mcp (a read-only grant sees only read tools) → refresh → revoke → 401 with WWW-Authenticate.
 * Nothing leaves localhost: the metadata fetcher, the stores, the audit and the tools are fakes.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AuthService } from '../../auth/auth.service';
import { makeAuth } from '../../auth/testing/fakes';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { ConnectorAdminController } from '../admin/admin.controller';
import { CONNECTOR_AUDIT, MemoryAudit } from '../audit/audit';
import { ClientRegistry, type MetadataFetcher } from '../oauth/clients';
import { CIMD_URL_HOSTED } from '../oauth/constants';
import { DiscoveryController } from '../oauth/discovery.controller';
import { MemoryOAuthStore } from '../oauth/memory-store';
import { CLIENT_REGISTRY, OAuthController } from '../oauth/oauth.controller';
import { OAuthService } from '../oauth/oauth.service';
import { s256 } from '../oauth/crypto';
import { OAUTH_STORE } from '../oauth/store';
import { CONNECTOR_TOOLS, type ConnectorTool } from '../types';
import { CONNECTOR_CONFIG, OAUTH_SERVICE, makeConnectorConfig } from './config';
import { MCP_ENDPOINT, McpController } from './mcp.controller';
import { McpEndpoint } from './mcp-endpoint';
import { mcpJsonBody } from './mcp-body.middleware';
import { randomBytes } from 'crypto';

const ORIGIN = 'https://dev.ai0.global';
const env: Record<string, string | undefined> = { MCP_CONNECTOR: 'on', MCP_PUBLIC_URL: ORIGIN, NODE_ENV: 'production', TRACKING_TOKEN: 'test-tracking-token' };

let metaFetches = 0;
const cimdFetcher: MetadataFetcher = async (url) => {
  metaFetches++;
  return { status: 200, text: JSON.stringify({ client_id: url, client_name: 'Claude (fake doc)', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) };
};

const tools: ConnectorTool[] = [
  { name: 'list_channels', title: 'List channels', scope: 'mcp:read', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: false }, call: async () => ({ channels: ['@a'] }) },
  { name: 'prepare_post', title: 'Prepare post', scope: 'mcp:write', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true }, call: async () => ({ ok: true }) },
];

/** A fake owner session: the header picks how the request authenticated. */
const fakeAuth = {
  authenticate: async (req: any) => {
    const how = req.headers['x-test-auth'];
    if (how === 'session') return { ok: true, method: 'session', identity: { sub: 1, firstName: 'Owner' } };
    if (how === 'bearer') return { ok: true, method: 'bearer', identity: { sub: 0, firstName: 'Operator' } };
    return { ok: false, code: 'no_credentials' };
  },
};

let app: NestExpressApplication;
let port: number;
const store = new MemoryOAuthStore();
const audit = new MemoryAudit();

before(async () => {
  Reflect.defineMetadata('design:paramtypes', [AuthService], TrackingAuthGuard);
  const registry = new ClientRegistry(store, cimdFetcher, () => new Date(), audit);
  const oauth = new OAuthService(store, registry, audit);
  const cfg = makeConnectorConfig((k) => env[k]);
  @Module({
    controllers: [DiscoveryController, OAuthController, McpController, ConnectorAdminController],
    providers: [
      TrackingAuthGuard,
      { provide: AuthService, useValue: fakeAuth },
      { provide: CONNECTOR_CONFIG, useValue: cfg },
      { provide: OAUTH_STORE, useValue: store },
      { provide: CONNECTOR_AUDIT, useValue: audit },
      { provide: CLIENT_REGISTRY, useValue: registry },
      { provide: OAUTH_SERVICE, useValue: oauth },
      { provide: CONNECTOR_TOOLS, useValue: { tools: async () => tools } },
      { provide: MCP_ENDPOINT, useValue: new McpEndpoint({ cfg, oauth, store, tools: { tools: async () => tools }, audit }) },
    ],
  })
  class TestModule {}
  app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use('/api/mcp', mcpJsonBody);
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
});
after(async () => { await app?.close(); });

interface Resp { status: number; headers: Record<string, any>; text: string; json: any }
function call(method: string, path: string, o: { json?: unknown; form?: Record<string, string>; raw?: string; headers?: Record<string, string> } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = o.raw ?? (o.json !== undefined ? JSON.stringify(o.json) : o.form ? new URLSearchParams(o.form).toString() : undefined);
    const ct = o.json !== undefined ? 'application/json' : o.form ? 'application/x-www-form-urlencoded' : undefined;
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(ct ? { 'content-type': ct } : {}), ...(o.headers ?? {}) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json: any = null; try { json = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, headers: res.headers, text: buf, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const rpc = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  call('POST', '/api/mcp', { json: body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function authorizeAndConsent(clientId: string, o: { scope?: string; chosen?: string[]; state?: string } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: 'S256',
    state: o.state ?? 'xyz', resource: `${ORIGIN}/api/mcp`, ...(o.scope ? { scope: o.scope } : {}),
  });
  const a = await call('GET', `/api/oauth/authorize?${q}`);
  assert.equal(a.status, 302);
  const loc = new URL(a.headers.location);
  assert.equal(loc.origin + loc.pathname, `${ORIGIN}/app/oauth/consent`);
  const id = loc.searchParams.get('request')!;
  const info = await call('GET', `/api/oauth/requests/${id}`, { headers: { 'x-test-auth': 'session' } });
  assert.equal(info.status, 200);
  const d = await call('POST', `/api/oauth/requests/${id}/decision`, { json: { decision: 'allow', ...(o.chosen ? { scopes: o.chosen } : {}) }, headers: { 'x-test-auth': 'session', origin: ORIGIN } });
  assert.equal(d.status, 200, d.text);
  const back = new URL(d.json.redirect);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), o.state ?? 'xyz');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  return { code: back.searchParams.get('code')!, verifier, info: info.json, requestId: id };
}

const tokenForm = (clientId: string, code: string, verifier: string) => ({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });

test('discovery: protected resource, authorization server, caching, other well-known paths 404', async () => {
  for (const p of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'public, max-age=300');
    assert.deepEqual(r.json, {
      resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['mcp:read', 'mcp:write'], bearer_methods_supported: ['header'], resource_name: 'ai0',
    });
  }
  const as = await call('GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.status, 200);
  assert.equal(as.headers['cache-control'], 'public, max-age=300');
  assert.deepEqual(as.json, {
    issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/api/oauth/authorize`, token_endpoint: `${ORIGIN}/api/oauth/token`,
    registration_endpoint: `${ORIGIN}/api/oauth/register`, revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true, scopes_supported: ['mcp:read', 'mcp:write'],
  });
  assert.equal((await call('GET', '/.well-known/openid-configuration')).status, 404);
});

test('the whole dance with a DCR client: register → authorize → consent → token → mcp → refresh → revoke → 401', async () => {
  const reg = await call('POST', '/api/oauth/register', { json: { client_name: 'Claude Desktop', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.json.client_id as string;

  const { code, verifier, info } = await authorizeAndConsent(clientId);
  assert.equal(info.client.name, 'Claude Desktop');
  assert.equal(info.client.redirectHost, 'claude.ai');

  // form-urlencoded, as Claude sends it
  const tok = await call('POST', '/api/oauth/token', { form: tokenForm(clientId, code, verifier) });
  assert.equal(tok.status, 200, tok.text);
  assert.equal(tok.headers['cache-control'], 'no-store');
  assert.equal(tok.json.token_type, 'Bearer');
  assert.equal(tok.json.expires_in, 3600);
  const at1 = tok.json.access_token as string;
  const rt1 = tok.json.refresh_token as string;

  // a replayed code is refused (and kills the grant, checked below with the second pair)
  const init = await rpc(at1, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } });
  assert.equal(init.status, 200);
  assert.equal(init.headers['content-type'].startsWith('application/json'), true);
  assert.equal(init.json.result.serverInfo.name, 'ai0');
  assert.ok(init.json.result.instructions.length > 100);
  assert.equal((await rpc(at1, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc(at1, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.json.result.tools.map((t: any) => t.name), ['list_channels', 'prepare_post']);
  const callRes = await rpc(at1, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_channels', arguments: {} } });
  assert.equal(callRes.json.result.isError, false);

  // refresh as JSON
  const ref = await call('POST', '/api/oauth/token', { json: { grant_type: 'refresh_token', client_id: clientId, refresh_token: rt1 } });
  assert.equal(ref.status, 200, ref.text);
  const at2 = ref.json.access_token as string;
  assert.notEqual(at2, at1);
  assert.equal((await rpc(at2, { jsonrpc: '2.0', id: 4, method: 'ping' })).status, 200);

  // revoke
  const rev = await call('POST', '/api/oauth/revoke', { form: { token: ref.json.refresh_token } });
  assert.equal(rev.status, 200);
  const dead = await rpc(at2, { jsonrpc: '2.0', id: 5, method: 'ping' });
  assert.equal(dead.status, 401);
  assert.equal(dead.headers['www-authenticate'], `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read mcp:write", error="invalid_token"`);
  assert.equal((await rpc(at1, { jsonrpc: '2.0', id: 6, method: 'ping' })).status, 401);
  assert.equal((await call('POST', '/api/oauth/token', { json: { grant_type: 'refresh_token', client_id: clientId, refresh_token: ref.json.refresh_token } })).status, 400);

  const events = audit.entries.map((e) => e.event);
  for (const e of ['register', 'consent_allow', 'token_issued', 'tool_call', 'revoked']) assert.ok(events.includes(e as any), e);
});

test('the whole dance with the CIMD client (fake fetcher); a read-only grant sees only read tools', async () => {
  const before = metaFetches;
  const { code, verifier, info } = await authorizeAndConsent(CIMD_URL_HOSTED, { scope: 'mcp:read mcp:write', chosen: ['mcp:read'] });
  assert.ok(metaFetches > before, 'the metadata document was fetched through the injected fetcher');
  assert.equal(info.client.name, 'Claude (fake doc)');
  assert.equal(info.client.kind, 'cimd');
  const tok = await call('POST', '/api/oauth/token', { form: tokenForm(CIMD_URL_HOSTED, code, verifier) });
  assert.equal(tok.status, 200, tok.text);
  assert.equal(tok.json.scope, 'mcp:read');
  const list = await rpc(tok.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.json.result.tools.map((t: any) => t.name), ['list_channels']);
  const denied = await rpc(tok.json.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'prepare_post', arguments: {} } });
  assert.equal(denied.json.error.code, -32602);
  // replaying the code is refused and kills the grant
  const replay = await call('POST', '/api/oauth/token', { form: tokenForm(CIMD_URL_HOSTED, code, verifier) });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error, 'invalid_grant');
  assert.equal((await rpc(tok.json.access_token, { jsonrpc: '2.0', id: 3, method: 'ping' })).status, 401);
});

test('authorize: a bad redirect_uri or client renders an HTML page (400), never a redirect', async () => {
  const challenge = s256('v'.repeat(43));
  const bad = await call('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL_HOSTED, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`);
  assert.equal(bad.status, 400);
  assert.match(String(bad.headers['content-type']), /html/);
  assert.equal(bad.headers.location, undefined);
  const unknown = await call('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'https://evil.example/meta', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })}`);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.location, undefined);
});

test('consent API: needs a session; a TRACKING_TOKEN bearer cannot decide; a foreign Origin is refused', async () => {
  const verifier = randomBytes(32).toString('base64url');
  const a = await call('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL_HOSTED, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: 'S256' })}`);
  const id = new URL(a.headers.location).searchParams.get('request')!;
  assert.equal((await call('GET', `/api/oauth/requests/${id}`)).status, 401);
  assert.equal((await call('POST', `/api/oauth/requests/${id}/decision`, { json: { decision: 'allow' } })).status, 401);
  assert.equal((await call('POST', `/api/oauth/requests/${id}/decision`, { json: { decision: 'allow' }, headers: { 'x-test-auth': 'bearer' } })).status, 403);
  assert.equal((await call('POST', `/api/oauth/requests/${id}/decision`, { json: { decision: 'allow' }, headers: { 'x-test-auth': 'session', origin: 'https://evil.example' } })).status, 403);
  const deny = await call('POST', `/api/oauth/requests/${id}/decision`, { json: { decision: 'deny' }, headers: { 'x-test-auth': 'session' } });
  assert.equal(deny.status, 200);
  assert.equal(new URL(deny.json.redirect).searchParams.get('error'), 'access_denied');
  assert.equal((await call('POST', `/api/oauth/requests/${id}/decision`, { json: { decision: 'allow' }, headers: { 'x-test-auth': 'session' } })).status, 410);
  assert.equal((await call('GET', '/api/oauth/requests/unknown-id', { headers: { 'x-test-auth': 'session' } })).status, 404);
});

test('token endpoint errors are RFC 6749 JSON with no-store', async () => {
  const r = await call('POST', '/api/oauth/token', { form: { grant_type: 'password', client_id: 'x' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'unsupported_grant_type');
  assert.equal(r.headers['cache-control'], 'no-store');
  const noClient = await call('POST', '/api/oauth/token', { form: { grant_type: 'refresh_token', client_id: 'ghost', refresh_token: 'x' } });
  assert.equal(noClient.status, 401);
  assert.equal(noClient.json.error, 'invalid_client');
});

test('/api/mcp: no token → 401 + challenge; GET and DELETE → 405; oversize body refused after auth', async () => {
  const none = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(none.status, 401);
  assert.equal(none.headers['www-authenticate'], `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read mcp:write"`);
  for (const m of ['GET', 'DELETE']) {
    const r = await call(m, '/api/mcp');
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'POST');
  }
  // TRACKING_TOKEN is not a connector token
  assert.equal((await rpc('test-tracking-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('/api/mcp: a body over 1 MB is 413 once authenticated; invalid JSON is a JSON-RPC parse error', async () => {
  const reg = await call('POST', '/api/oauth/register', { json: { redirect_uris: [REDIRECT] } });
  const clientId = reg.json.client_id as string;
  const { code, verifier } = await authorizeAndConsent(clientId);
  const tok = await call('POST', '/api/oauth/token', { form: tokenForm(clientId, code, verifier) });
  const at = tok.json.access_token as string;
  const big = await rpc(at, { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_100_000) } });
  assert.equal(big.status, 413);
  const bad = await call('POST', '/api/mcp', { headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' }, raw: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, -32700);
  const batch = await rpc(at, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(batch.status, 400);
  assert.equal(batch.json.error.code, -32600);
});

test('admin API: status, clients, grants, activity, revoke one, remove a client, revoke all', async () => {
  const hdr = { 'x-test-auth': 'bearer' };
  assert.equal((await call('GET', '/api/connector/status')).status, 401);
  const st = await call('GET', '/api/connector/status', { headers: hdr });
  assert.deepEqual(st.json, { enabled: true, configured: true, url: `${ORIGIN}/api/mcp`, issuer: ORIGIN, httpsOk: true, dashboardOrigin: ORIGIN, reason: null });

  const clients = await call('GET', '/api/connector/clients', { headers: hdr });
  assert.ok(clients.json.clients.length >= 2);
  const c = clients.json.clients[0];
  for (const k of ['id', 'clientId', 'kind', 'name', 'redirectHosts', 'createdAt', 'lastUsedAt', 'activeGrants']) assert.ok(k in c, k);

  // a fresh grant to play with
  const reg = await call('POST', '/api/oauth/register', { json: { redirect_uris: [REDIRECT], client_name: 'Admin test' } });
  const clientId = reg.json.client_id as string;
  const { code, verifier } = await authorizeAndConsent(clientId);
  const tok = await call('POST', '/api/oauth/token', { form: tokenForm(clientId, code, verifier) });
  await rpc(tok.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' });

  const grants = await call('GET', '/api/connector/grants', { headers: hdr });
  const g = grants.json.grants.find((x: any) => x.clientId === clientId);
  assert.ok(g);
  for (const k of ['id', 'clientId', 'clientName', 'scopes', 'createdAt', 'lastUsedAt', 'lastIp', 'expiresAt']) assert.ok(k in g, k);
  assert.deepEqual(g.scopes, ['mcp:read', 'mcp:write']);
  assert.ok(g.lastUsedAt, 'the first request touched the grant');

  const act = await call('GET', '/api/connector/activity?limit=5', { headers: hdr });
  assert.ok(act.json.items.length <= 5);
  for (const k of ['id', 'at', 'event', 'tool', 'clientName', 'ok', 'error', 'durationMs', 'summary']) assert.ok(k in act.json.items[0], k);

  assert.deepEqual((await call('DELETE', `/api/connector/grants/${g.id}`, { headers: hdr })).json, { ok: true });
  const after = await call('GET', '/api/connector/activity?limit=10', { headers: hdr });
  assert.equal(after.json.items.find((x: any) => x.event === 'revoked')?.ok, true, 'D1: OAuth audit rows carry ok, so the dashboard does not show them as errors');
  assert.equal((await rpc(tok.json.access_token, { jsonrpc: '2.0', id: 2, method: 'ping' })).status, 401);
  assert.equal((await call('DELETE', '/api/connector/grants/not-a-uuid', { headers: hdr })).status, 400);

  // remove a client with a live grant
  const reg2 = await call('POST', '/api/oauth/register', { json: { redirect_uris: [REDIRECT] } });
  const c2 = reg2.json.client_id as string;
  const a2 = await authorizeAndConsent(c2);
  const t2 = await call('POST', '/api/oauth/token', { form: tokenForm(c2, a2.code, a2.verifier) });
  const row = (await call('GET', '/api/connector/clients', { headers: hdr })).json.clients.find((x: any) => x.clientId === c2);
  assert.equal(row.activeGrants, 1);
  assert.deepEqual((await call('DELETE', `/api/connector/clients/${row.id}`, { headers: hdr })).json, { ok: true, revoked: 1 });
  assert.equal((await rpc(t2.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);

  const reg3 = await call('POST', '/api/oauth/register', { json: { redirect_uris: [REDIRECT] } });
  const c3 = reg3.json.client_id as string;
  const a3 = await authorizeAndConsent(c3);
  const t3 = await call('POST', '/api/oauth/token', { form: tokenForm(c3, a3.code, a3.verifier) });
  const all = await call('POST', '/api/connector/grants/revoke-all', { headers: hdr });
  assert.equal(all.json.ok, true);
  assert.ok(all.json.revoked >= 1);
  assert.equal((await rpc(t3.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('connector off: everything except the admin API answers 404 connector_off', async () => {
  const saved = env.MCP_CONNECTOR;
  env.MCP_CONNECTOR = 'off';
  try {
    for (const [m, p] of [
      ['GET', '/.well-known/oauth-protected-resource/api/mcp'], ['GET', '/.well-known/oauth-protected-resource'], ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/api/oauth/authorize'], ['POST', '/api/oauth/token'], ['POST', '/api/oauth/register'], ['POST', '/api/oauth/revoke'],
      ['POST', '/api/mcp'], ['GET', '/api/mcp'],
    ]) {
      const r = await call(m, p);
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.deepEqual(r.json, { error: 'connector_off' }, `${m} ${p}`);
    }
    const consent = await call('GET', '/api/oauth/requests/x', { headers: { 'x-test-auth': 'session' } });
    assert.equal(consent.status, 404);
    assert.deepEqual(consent.json, { error: 'connector_off' });
    const st = await call('GET', '/api/connector/status', { headers: { 'x-test-auth': 'bearer' } });
    assert.equal(st.status, 200);
    assert.equal(st.json.enabled, false);
    assert.equal(st.json.reason, 'off');
  } finally {
    env.MCP_CONNECTOR = saved;
  }
});

test('the real TrackingAuthGuard never accepts a connector token, and /api/mcp never accepts TRACKING_TOKEN or a session', async () => {
  const tokens = await (async () => {
    const reg = await call('POST', '/api/oauth/register', { json: { redirect_uris: [REDIRECT] } });
    const clientId = reg.json.client_id as string;
    const { code, verifier } = await authorizeAndConsent(clientId);
    return (await call('POST', '/api/oauth/token', { form: tokenForm(clientId, code, verifier) })).json;
  })();

  const real = makeAuth({ TRACKING_TOKEN: 'test-tracking-token' }).auth;
  @Module({ controllers: [ConnectorAdminController], providers: [
    TrackingAuthGuard, { provide: AuthService, useValue: real }, { provide: CONNECTOR_CONFIG, useValue: makeConnectorConfig((k) => env[k]) },
    { provide: OAUTH_STORE, useValue: store }, { provide: CONNECTOR_AUDIT, useValue: audit },
  ] })
  class GuardModule {}
  const g = await NestFactory.create<NestExpressApplication>(GuardModule, { logger: false });
  await g.listen(0, '127.0.0.1');
  const gp = (g.getHttpServer().address() as AddressInfo).port;
  const status = (token: string | null) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: gp, path: '/api/connector/status', headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await status('test-tracking-token'), 200);
    assert.equal(await status(tokens.access_token), 401, 'an access token is not a dashboard credential');
    assert.equal(await status(tokens.refresh_token), 401);
    assert.equal(await status(null), 401);
  } finally {
    await g.close();
  }
});
