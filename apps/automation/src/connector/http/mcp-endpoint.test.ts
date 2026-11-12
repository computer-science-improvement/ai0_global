import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolFailure } from '../../editor/mcp/mcp-server';
import { MemoryAudit, summarizeArgs } from '../audit/audit';
import { HOSTED_REDIRECT, URLS, getCode, makeOAuth, registerDcr } from '../oauth/testing/fixtures';
import type { ConnectorTool } from '../types';
import { makeConnectorConfig } from './config';
import { McpEndpoint, SERVER_INSTRUCTIONS, type Res } from './mcp-endpoint';

const env = (o: Record<string, string> = {}) => makeConnectorConfig((k) => ({ MCP_CONNECTOR: 'on', MCP_PUBLIC_URL: 'https://dev.ai0.global', NODE_ENV: 'production', ...o })[k]);

class FakeRes implements Res {
  code = 200; headers: Record<string, string> = {}; body: unknown = undefined; ended = false;
  status(c: number) { this.code = c; return this; }
  setHeader(n: string, v: string) { this.headers[n.toLowerCase()] = v; return this; }
  json(b: unknown) { this.body = b; this.ended = true; return this; }
  end() { this.ended = true; return this; }
}

const readTool = (calls: unknown[][] = []): ConnectorTool => ({
  name: 'list_channels', title: 'List channels', scope: 'mcp:read', description: 'd', inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, openWorldHint: false }, call: async (a) => { calls.push([a]); return { channels: [] }; },
});
const writeTool = (call: ConnectorTool['call'] = async () => ({ ok: true })): ConnectorTool => ({
  name: 'prepare_post', title: 'Prepare post', scope: 'mcp:write', description: 'd', inputSchema: { type: 'object' },
  annotations: { readOnlyHint: false, destructiveHint: true }, call,
});

async function setup(o: { tools?: ConnectorTool[]; scope?: string; cfg?: ReturnType<typeof env>; toolTimeoutMs?: number; rateLimitPerMin?: number } = {}) {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId, { scope: o.scope });
  const tok = await h.oauth.token({ grant_type: 'authorization_code', client_id: clientId, code: c.code, code_verifier: c.verifier, redirect_uri: HOSTED_REDIRECT }, URLS, { ip: null });
  const audit = new MemoryAudit();
  const touches: string[] = [];
  const tools = o.tools ?? [readTool(), writeTool()];
  const ep = new McpEndpoint({
    cfg: o.cfg ?? env(), oauth: h.oauth, store: { touchGrant: async (id) => { touches.push(id); } }, tools: { tools: async () => tools }, audit,
    now: h.clock.now, toolTimeoutMs: o.toolTimeoutMs, rateLimitPerMin: o.rateLimitPerMin,
  });
  const post = async (body: unknown, headers: Record<string, string> = {}, mcpBody: 'ok' | 'invalid_json' | 'too_large' | 'none' = 'ok', method = 'POST') => {
    const res = new FakeRes();
    await ep.handle({ method, headers: { authorization: `Bearer ${tok.access_token}`, ...headers }, body, mcpBody, ip: '3.3.3.3' }, res);
    return res;
  };
  return { h, ep, tok, audit, touches, post };
}

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const notification = (method: string) => ({ jsonrpc: '2.0', method });

test('connector off or not configured: 404 connector_off', async () => {
  for (const cfg of [env({ MCP_CONNECTOR: 'off' }), env({ MCP_PUBLIC_URL: '', DASHBOARD_URL: '' })]) {
    const s = await setup({ cfg });
    const r = await s.post(rpc('ping'));
    assert.equal(r.code, 404);
    assert.deepEqual(r.body, { error: 'connector_off' });
  }
});

test('GET and DELETE are 405 with Allow: POST', async () => {
  const s = await setup();
  for (const m of ['GET', 'DELETE', 'PUT']) {
    const r = await s.post(undefined, {}, 'none', m);
    assert.equal(r.code, 405);
    assert.equal(r.headers['allow'], 'POST');
  }
});

test('no token: 401 with the exact WWW-Authenticate; a bad token adds error="invalid_token"', async () => {
  const s = await setup();
  const none = await s.post(rpc('ping'), { authorization: '' });
  assert.equal(none.code, 401);
  assert.equal(none.headers['www-authenticate'], `Bearer resource_metadata="${URLS.prm}", scope="mcp:read mcp:write"`);
  const bad = await s.post(rpc('ping'), { authorization: 'Bearer ai0mcp_at_nope' });
  assert.equal(bad.code, 401);
  assert.equal(bad.headers['www-authenticate'], `Bearer resource_metadata="${URLS.prm}", scope="mcp:read mcp:write", error="invalid_token"`);
});

test('TRACKING_TOKEN, a refresh token and a dashboard-session cookie are not accepted', async () => {
  const s = await setup();
  assert.equal((await s.post(rpc('ping'), { authorization: 'Bearer test-tracking-token' })).code, 401);
  assert.equal((await s.post(rpc('ping'), { authorization: `Bearer ${s.tok.refresh_token}` })).code, 401);
  const cookieOnly = new FakeRes();
  await s.ep.handle({ method: 'POST', headers: { cookie: 'tracking_jwt=abc' }, body: rpc('ping'), mcpBody: 'ok' }, cookieOnly);
  assert.equal(cookieOnly.code, 401);
});

test('a token minted for another resource is refused', async () => {
  const s = await setup({ cfg: env({ MCP_PUBLIC_URL: 'https://other.example' }) });
  assert.equal((await s.post(rpc('ping'))).code, 401);
});

test('Origin: absent, Claude and the public origin pass; others are 403; localhost only outside production', async () => {
  const s = await setup();
  assert.equal((await s.post(rpc('ping'))).code, 200);
  for (const o of ['https://claude.ai', 'https://claude.com', 'https://dev.ai0.global']) assert.equal((await s.post(rpc('ping'), { origin: o })).code, 200, o);
  for (const o of ['https://evil.example', 'http://localhost:3000', 'null']) assert.equal((await s.post(rpc('ping'), { origin: o })).code, 403, o);
  const dev = await setup({ cfg: env({ NODE_ENV: 'development' }) });
  assert.equal((await dev.post(rpc('ping'), { origin: 'http://localhost:5173' })).code, 200);
  assert.equal((await dev.post(rpc('ping'), { origin: 'http://localhost.evil.example' })).code, 403);
});

test('MCP-Protocol-Version: supported passes, unknown is 400', async () => {
  const s = await setup();
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) assert.equal((await s.post(rpc('ping'), { 'mcp-protocol-version': v })).code, 200, v);
  assert.equal((await s.post(rpc('ping'), { 'mcp-protocol-version': '2099-01-01' })).code, 400);
});

test('body: a batch gets a JSON-RPC invalid-request error; bad JSON, empty and oversize bodies are refused', async () => {
  const s = await setup();
  const batch = await s.post([rpc('ping'), rpc('ping', undefined, 2)]);
  assert.equal(batch.code, 400);
  assert.equal((batch.body as any).error.code, -32600);
  const bad = await s.post(undefined, {}, 'invalid_json');
  assert.equal(bad.code, 400);
  assert.equal((bad.body as any).error.code, -32700);
  assert.equal((await s.post(undefined, {}, 'none')).code, 400);
  assert.equal((await s.post(undefined, {}, 'too_large')).code, 413);
});

test('notifications are 202 with an empty body; requests are 200 JSON', async () => {
  const s = await setup();
  const n = await s.post(notification('notifications/initialized'));
  assert.equal(n.code, 202);
  assert.equal(n.body, undefined);
  const r = await s.post(rpc('ping'));
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal((await s.post({ jsonrpc: '2.0', id: 9, result: {} })).code, 202, 'a client response is acknowledged');
});

test('initialize returns the server info and the instructions', async () => {
  const s = await setup();
  const r = await s.post(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
  const res = (r.body as any).result;
  assert.equal(res.protocolVersion, '2025-11-25');
  assert.deepEqual(res.serverInfo, {
    name: 'ai0', version: '1.0.0', title: 'ai0 network', websiteUrl: 'https://dev.ai0.global',
    icons: [
      { src: 'https://dev.ai0.global/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
      { src: 'https://dev.ai0.global/icon-192.png', mimeType: 'image/png', sizes: ['192x192'] },
      { src: 'https://dev.ai0.global/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  });
  assert.equal(res.instructions, SERVER_INSTRUCTIONS);
  for (const word of ['timezone', 'locked', 'untrusted', 'publish']) assert.ok(SERVER_INSTRUCTIONS.toLowerCase().includes(word), word);
});

test('tools/list is filtered by scope: a read-only grant sees only read tools', async () => {
  const both = await setup();
  const names = async (s: typeof both) => ((await s.post(rpc('tools/list'))).body as any).result.tools.map((t: any) => t.name);
  assert.deepEqual(await names(both), ['list_channels', 'prepare_post']);
  const ro = await setup({ scope: 'mcp:read' });
  assert.deepEqual(await names(ro), ['list_channels']);
  const call = await ro.post(rpc('tools/call', { name: 'prepare_post', arguments: {} }));
  assert.equal((call.body as any).error.code, -32602, 'a tool outside the grant does not exist for it');
});

test('tools/list carries titles and annotations', async () => {
  const s = await setup();
  const t = ((await s.post(rpc('tools/list'))).body as any).result.tools;
  assert.deepEqual(t[0].annotations, { readOnlyHint: true, openWorldHint: false });
  assert.equal(t[1].title, 'Prepare post');
});

test('tools/call writes an audit row with ids only, never post text', async () => {
  const s = await setup();
  const r = await s.post(rpc('tools/call', { name: 'prepare_post', arguments: { channel: '@c', at: '2026-11-13 10:00', post: { text: 'SECRET BODY TEXT' }, notes: 'private' } }));
  assert.equal((r.body as any).result.isError, false);
  const row = s.audit.entries.find((e) => e.event === 'tool_call')!;
  assert.equal(row.tool, 'prepare_post');
  assert.equal(row.ok, true);
  assert.equal(row.clientId !== undefined, true);
  assert.equal(row.summary, 'channel=@c at=2026-11-13 10:00');
  assert.ok(!JSON.stringify(row).includes('SECRET'));
  assert.equal(typeof row.durationMs, 'number');
});

test('a failing tool is audited ok=false with its short reason; crashes do not leak internals', async () => {
  const s = await setup({ tools: [writeTool(async () => { throw new ToolFailure('unknown channel'); })] });
  const r = await s.post(rpc('tools/call', { name: 'prepare_post', arguments: { channel: '@x' } }));
  assert.equal((r.body as any).result.isError, true);
  assert.deepEqual([s.audit.entries.at(-1)?.ok, s.audit.entries.at(-1)?.error], [false, 'unknown channel']);
  const c = await setup({ tools: [writeTool(async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'); })] });
  const crashed = await c.post(rpc('tools/call', { name: 'prepare_post', arguments: {} }));
  assert.equal(c.audit.entries.at(-1)?.error, 'internal error');
  assert.ok(!JSON.stringify(crashed.body).includes('hunter2'), 'the caller never sees the internal message');
  assert.equal((crashed.body as any).result.isError, true);
});

test('a tool that runs past the cap is cut off with a tool error', async () => {
  const s = await setup({ toolTimeoutMs: 30, tools: [writeTool(() => new Promise(() => undefined))] });
  const r = await s.post(rpc('tools/call', { name: 'prepare_post', arguments: {} }));
  assert.equal((r.body as any).result.isError, true);
  assert.match((r.body as any).result.content[0].text, /did not finish/);
});

test('rate limit: the 121st request in a minute is 429 rate_limited; the next minute is fine', async () => {
  const s = await setup({ rateLimitPerMin: 5 });
  for (let i = 0; i < 5; i++) assert.equal((await s.post(rpc('ping'))).code, 200);
  const r = await s.post(rpc('ping', undefined, 7));
  assert.equal(r.code, 429);
  assert.deepEqual((r.body as any).error, { code: -32000, message: 'rate_limited' });
  assert.equal((r.body as any).id, 7);
  s.h.clock.advance(61_000);
  assert.equal((await s.post(rpc('ping'))).code, 200);
});

test('grant last_used / last_ip are touched at most once a minute', async () => {
  const s = await setup();
  for (let i = 0; i < 5; i++) await s.post(rpc('ping'));
  assert.equal(s.touches.length, 1);
  s.h.clock.advance(61_000);
  await s.post(rpc('ping'));
  assert.equal(s.touches.length, 2);
});

test('summarizeArgs keeps ids and times, drops text', () => {
  assert.equal(summarizeArgs({ channel: '@c', post_id: 'p1', post: 'text', message: 'hi', notes: 'n', topic: 't' }), 'channel=@c post_id=p1');
  assert.equal(summarizeArgs(null), '');
  assert.ok(summarizeArgs({ channel: 'x'.repeat(500) }).length <= 70);
});

// ── review fixes (spec 103 fix pass) ─────────────────────────────────────────

test('AUTH-5: a call to a tool outside the grant, or an unknown tool, is refused and audited', async () => {
  const s = await setup({ scope: 'mcp:read' });
  const out = await s.post(rpc('tools/call', { name: 'prepare_post', arguments: { channel: '@c', post: { text: 'SECRET' } } }));
  assert.equal((out.body as any).error.code, -32602);
  const unknown = await s.post(rpc('tools/call', { name: 'x'.repeat(300), arguments: {} }));
  assert.equal((unknown.body as any).error.code, -32602);
  const rows = s.audit.entries.filter((e) => e.event === 'tool_call');
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].tool, rows[0].ok, rows[0].error], ['prepare_post', false, 'not_allowed_for_scope']);
  assert.deepEqual([rows[1].tool?.length, rows[1].ok, rows[1].error], [100, false, 'unknown_tool']);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
  // an allowed call still writes exactly one row
  await s.post(rpc('tools/call', { name: 'list_channels', arguments: {} }));
  assert.equal(s.audit.entries.filter((e) => e.event === 'tool_call').length, 3);
});

test('C5: results are compact JSON; an oversized result is cut with truncated:true and a hint, under the budget', async () => {
  const big = { steps: Array.from({ length: 60 }, (_, i) => ({ idx: i, input: 'я'.repeat(2000), output: 'o'.repeat(2000) })), run: { id: 'r1' }, untrusted_fields: ['steps[].input'] };
  const s = await setup({ tools: [readTool(), { ...readTool(), name: 'get_run', call: async () => big }, { ...readTool(), name: 'small', call: async () => ({ a: 1, b: [1, 2] }) }] });
  const small = await s.post(rpc('tools/call', { name: 'small', arguments: {} }));
  assert.equal((small.body as any).result.content[0].text, '{"a":1,"b":[1,2]}', 'compact, no indentation');
  const r = await s.post(rpc('tools/call', { name: 'get_run', arguments: {} }));
  const text: string = (r.body as any).result.content[0].text;
  assert.ok(text.length <= 80_000, `${text.length} chars`);
  const parsed = JSON.parse(text);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.hint, /too large/);
  assert.ok(parsed.steps.length >= 1 && parsed.steps.length < 60);
  assert.equal(parsed.run.id, 'r1');
  assert.equal((r.body as any).result.isError, false);
});

test('spec 104: the endpoint serves the factory\'s resources (MCP Apps view) and the view\'s structuredContent next to the text', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId, { scope: 'mcp:read' });
  const tok = await h.oauth.token({ grant_type: 'authorization_code', client_id: clientId, code: c.code, code_verifier: c.verifier, redirect_uri: HOSTED_REDIRECT }, URLS, { ip: null });
  const view = { uri: 'ui://ai0/preview-abc.html', name: 'ai0-preview', mimeType: 'text/html;profile=mcp-app', _meta: { ui: { prefersBorder: false } }, read: async () => ({ text: '<p>x</p>', _meta: { ui: { prefersBorder: false } } }) };
  const tool: ConnectorTool = { ...readTool(), _meta: { ui: { resourceUri: view.uri, visibility: ['model'] } }, view: async () => ({ ai0_view: 1, view: { kind: 'schedule' } }) };
  const asked: string[] = [];
  const ep = new McpEndpoint({
    cfg: env(), oauth: h.oauth, store: { touchGrant: async () => {} }, audit: new MemoryAudit(), now: h.clock.now,
    tools: { tools: async () => [tool], resources: async (p) => { asked.push(p.grantId); return [view]; } },
  });
  const post = async (body: unknown) => {
    const res = new FakeRes();
    await ep.handle({ method: 'POST', headers: { authorization: `Bearer ${tok.access_token}` }, body, mcpBody: 'ok', ip: '3.3.3.3' }, res);
    return res.body as any;
  };
  const init = await post(rpc('initialize', { protocolVersion: '2025-11-25' }));
  assert.deepEqual(init.result.capabilities.resources, { listChanged: false });
  const read = await post(rpc('resources/read', { uri: view.uri }));
  assert.equal(read.result.contents[0].text, '<p>x</p>');
  assert.equal(read.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  const listed = await post(rpc('tools/list'));
  assert.deepEqual(listed.result.tools[0]._meta.ui, { resourceUri: view.uri, visibility: ['model'] });
  const called = await post(rpc('tools/call', { name: 'list_channels', arguments: {} }));
  assert.equal(called.result.content[0].text, JSON.stringify({ channels: [] }));
  assert.deepEqual(called.result.structuredContent, { ai0_view: 1, view: { kind: 'schedule' } });
  assert.equal(asked.length, 1);
  const plainEp = new McpEndpoint({ cfg: env(), oauth: h.oauth, store: { touchGrant: async () => {} }, audit: new MemoryAudit(), now: h.clock.now, tools: { tools: async () => [readTool()] } });
  const res = new FakeRes();
  await plainEp.handle({ method: 'POST', headers: { authorization: `Bearer ${tok.access_token}` }, body: rpc('resources/list'), mcpBody: 'ok', ip: '3.3.3.3' }, res);
  assert.equal((res.body as any).error.code, -32601, 'a factory without resources: no resources methods, as before');
});
