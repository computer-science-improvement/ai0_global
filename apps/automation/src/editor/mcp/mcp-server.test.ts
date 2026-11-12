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
