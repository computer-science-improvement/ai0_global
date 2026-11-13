import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McpServer, McpTool, RPC, ToolFailure } from './mcp-server';

const echo: McpTool = {
  name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
  call: async (a) => ({ got: a.x }),
};
const failing: McpTool = { name: 'nope', description: 'fails', inputSchema: { type: 'object' }, call: async () => { throw new ToolFailure('refused: live is human-only'); } };
const crashing: McpTool = { name: 'boom', description: 'crashes', inputSchema: { type: 'object' }, call: async () => { throw new Error('socket hang up'); } };

const server = (logs: string[] = []) => new McpServer({ name: 'ai0-editor', version: '1.0.0', tools: async () => [echo, failing, crashing], log: (m) => logs.push(m) });

test('initialize negotiates the protocol version and advertises tools', async () => {
  const r = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  assert.deepEqual(r, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ai0-editor', version: '1.0.0' } } });
  const future = await server().handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal((future!.result as any).protocolVersion, '2025-11-25');
});

test('spec 103: initialize carries title and instructions; tools/list carries title and annotations', async () => {
  const annotated: McpTool = { ...echo, title: 'Echo', annotations: { readOnlyHint: true, openWorldHint: false } };
  const s = new McpServer({ name: 'ai0', title: 'ai0 network', version: '2', instructions: 'Use me well.', tools: async () => [annotated] });
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.deepEqual(init!.result, {
    protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'ai0', version: '2', title: 'ai0 network' }, instructions: 'Use me well.',
  });
  const icons = [{ src: 'https://x.test/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] }];
  const withIcons = new McpServer({ name: 'ai0', version: '2', icons, websiteUrl: 'https://x.test', tools: async () => [] });
  const init2 = await withIcons.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.deepEqual((init2!.result as any).serverInfo, { name: 'ai0', version: '2', icons, websiteUrl: 'https://x.test' });
  const list = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual((list!.result as any).tools[0], {
    name: 'echo', title: 'Echo', description: 'echo back', inputSchema: echo.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false },
  });
});

test('tools/list and tools/call', async () => {
  const s = server();
  const list = await s.handle({ jsonrpc: '2.0', id: 'a', method: 'tools/list' });
  assert.deepEqual((list!.result as any).tools.map((t: any) => t.name), ['echo', 'nope', 'boom']);
  assert.ok(!('call' in (list!.result as any).tools[0]));

  const ok = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 'hi' } } });
  assert.deepEqual(ok!.result, { content: [{ type: 'text', text: JSON.stringify({ got: 'hi' }, null, 2) }], isError: false });
});

test('tool failures are results with isError; unknown tools and methods are protocol errors', async () => {
  const logs: string[] = [];
  const s = server(logs);
  const refused = await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.deepEqual(refused!.result, { content: [{ type: 'text', text: 'refused: live is human-only' }], isError: true });
  const crashed = await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } });
  assert.equal((crashed!.result as any).isError, true);
  assert.equal(logs.length, 1, 'unexpected errors are logged, refusals are not');

  assert.equal((await s.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'zzz', arguments: {} } }))!.error!.code, RPC.INVALID_PARAMS);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' }))!.error!.code, RPC.METHOD_NOT_FOUND);
  assert.equal((await s.handle({ id: 8, method: 'ping' }))!.error!.code, RPC.INVALID_REQUEST);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 9, method: 'ping' }), { jsonrpc: '2.0', id: 9, result: {} });
});

test('stdio transport: newline-delimited JSON in, one response line per request out', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  output.on('data', (c) => { for (const l of String(c).split('\n').filter(Boolean)) lines.push(JSON.parse(l)); });
  const done = server().attach(input, output);
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('not json\n\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 'y' } } })}\n`);
  input.end();
  await done;
  // Requests run concurrently, so responses may arrive in any order.
  const byId = new Map(lines.map((l) => [l.id, l]));
  assert.equal(lines.length, 3);
  assert.deepEqual(byId.get(1).result, {});
  assert.equal(byId.get(null).error.code, RPC.PARSE);
  assert.equal(byId.get(2).result.isError, false);
});

test('fitResult (C5): compact, cut by halving the biggest array, then clipping strings; always within the budget', async () => {
  const { fitResult } = await import('./mcp-server');
  assert.equal(fitResult({ a: [1, 2] }, 100), '{"a":[1,2]}');
  const arr = JSON.parse(fitResult({ items: Array.from({ length: 100 }, (_, i) => ({ i, t: 'x'.repeat(100) })) }, 2000));
  assert.equal(arr.truncated, true);
  assert.ok(arr.items.length >= 1 && arr.items.length < 100);
  assert.equal(arr.items[0].i, 0, 'the first items are kept');
  const top = JSON.parse(fitResult([1, 2, 3, 'x'.repeat(5000)], 500));
  assert.equal(top.truncated, true);
  assert.ok(Array.isArray(top.items));
  const str = fitResult({ one: 'z'.repeat(50_000) }, 3000);
  assert.ok(str.length <= 3000);
  assert.equal(JSON.parse(str).truncated, true);
  const plain = fitResult('q'.repeat(10_000), 1000);
  assert.ok(plain.length <= 1000);
  assert.equal(JSON.parse(plain).truncated, true);
});

test('the stdio server keeps pretty-printed, unbounded results (no budget set)', async () => {
  const s = new McpServer({ name: 't', version: '1', tools: async () => [{ name: 'big', description: 'd', inputSchema: {}, call: async () => ({ a: 'x'.repeat(100_000) }) }] });
  const r: any = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'big', arguments: {} } });
  assert.ok(r.result.content[0].text.startsWith('{\n  "a"'));
  assert.ok(r.result.content[0].text.length > 100_000);
});

test('spec 104: tools/list passes _meta through; a view adds structuredContent and leaves the text byte-identical', async () => {
  const seen: unknown[][] = [];
  const viewed: McpTool = {
    ...echo, _meta: { ui: { resourceUri: 'ui://x/v.html', visibility: ['model'] } },
    view: async (args, result) => { seen.push([args, result]); return { ai0_view: 1, view: { kind: 'post', got: (result as any).got } }; },
  };
  const plain = new McpServer({ name: 't', version: '1', tools: async () => [echo], maxResultChars: 80_000 });
  const withView = new McpServer({ name: 't', version: '1', tools: async () => [viewed], maxResultChars: 80_000 });
  const list: any = await withView.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools[0]._meta, { ui: { resourceUri: 'ui://x/v.html', visibility: ['model'] } });
  assert.ok(!('view' in list.result.tools[0]));
  const call = { jsonrpc: '2.0' as const, id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 'hi' } } };
  const a: any = await plain.handle(call);
  const b: any = await withView.handle(call);
  assert.deepEqual(b.result.content, a.result.content, 'the text result is unchanged by the view');
  assert.equal(a.result.structuredContent, undefined);
  assert.deepEqual(b.result.structuredContent, { ai0_view: 1, view: { kind: 'post', got: 'hi' } });
  assert.deepEqual(seen, [[{ x: 'hi' }, { got: 'hi' }]]);
});

test('spec 104: viewIn { meta } puts the view in the result _meta instead of structuredContent (plain clients read structuredContent instead of the text)', async () => {
  const viewed: McpTool = { ...echo, view: async () => ({ ai0_view: 1, view: { kind: 'post' } }) };
  const plain = new McpServer({ name: 't', version: '1', tools: async () => [echo], maxResultChars: 80_000 });
  const s = new McpServer({ name: 't', version: '1', tools: async () => [viewed], maxResultChars: 80_000, viewIn: { meta: 'ai0/view' } });
  const call = { jsonrpc: '2.0' as const, id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 'hi' } } };
  const a: any = await plain.handle(call);
  const r: any = await s.handle(call);
  assert.deepEqual(r.result, { ...a.result, _meta: { 'ai0/view': { ai0_view: 1, view: { kind: 'post' } } } });
  assert.equal(r.result.structuredContent, undefined);
  const failing = new McpServer({ name: 't', version: '1', tools: async () => [{ ...echo, view: async () => { throw new Error('x'); } }], viewIn: { meta: 'ai0/view' }, log: () => {} });
  const f: any = await failing.handle(call);
  assert.equal(f.result._meta, undefined, 'no view: no _meta at all');
});

test('spec 104: a failing, slow, odd or oversized view leaves the call text-only; a refused call never builds a view', async () => {
  const logs: string[] = [];
  let built = 0;
  const mk = (name: string, view: McpTool['view'], call: McpTool['call'] = async () => ({ ok: 1 })): McpTool => ({ name, description: 'd', inputSchema: {}, call, view });
  const s = new McpServer({
    name: 't', version: '1', maxResultChars: 80_000, maxStructuredChars: 100, viewTimeoutMs: 20, log: (m) => logs.push(m),
    tools: async () => [
      mk('throws', async () => { throw new Error('db down'); }),
      mk('slow', () => new Promise((r) => setTimeout(() => r({ late: true }), 200))),
      mk('array', async () => [1, 2] as unknown as Record<string, unknown>),
      mk('big', async () => ({ v: 'x'.repeat(500) })),
      mk('refused', async () => { built++; return { v: 1 }; }, async () => { throw new ToolFailure('no'); }),
    ],
  });
  for (const name of ['throws', 'slow', 'array', 'big']) {
    const r: any = await s.handle({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } });
    assert.equal(r.result.isError, false, name);
    assert.equal(r.result.structuredContent, undefined, name);
    assert.equal(r.result.content[0].text, '{"ok":1}', name);
  }
  const refused: any = await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'refused', arguments: {} } });
  assert.equal(refused.result.isError, true);
  assert.equal(built, 0);
  assert.ok(logs.some((l) => /throws: view failed: db down/.test(l)));
  assert.ok(logs.some((l) => /big: view left out/.test(l)));
});
