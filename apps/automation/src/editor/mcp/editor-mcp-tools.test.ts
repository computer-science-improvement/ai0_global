import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEditorMcpTools, EditorApi, HttpEditorApi } from './editor-mcp-tools';
import { McpTool, ToolFailure } from './mcp-server';

const SLOT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

function fakeApi(modes: Record<string, string> = { '@space': 'shadow', '@news': 'live' }) {
  const calls: string[] = [];
  const api: EditorApi = {
    get: async (path) => {
      calls.push(`GET ${path}`);
      if (path === '/api/editor/tools') {
        return [{ name: 'lint_post', description: 'lint', parameters: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] }, roles: ['executor'] }];
      }
      const ch = path.match(/^\/api\/editor\/channels\/([^/?]+)$/);
      if (ch) {
        const key = decodeURIComponent(ch[1]);
        if (!modes[key]) throw new ToolFailure('404 channel_not_found');
        return { channelKey: key, mode: modes[key] };
      }
      if (path === `/api/editor/slots/${SLOT}`) return { id: SLOT, channelKey: '@space', status: 'planned' };
      if (path === '/api/editor/slots/2b4e28ba-2fa1-11d2-883f-0016d3cca427') return { id: 'x', channelKey: '@news', status: 'planned' };
      return { ok: true };
    },
    post: async (path, body) => { calls.push(`POST ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`); return { started: true }; },
    put:  async (path, body) => { calls.push(`PUT ${path} ${JSON.stringify(body)}`); return { card: body }; },
  };
  return { api, calls };
}

const byName = (tools: McpTool[], n: string) => {
  const t = tools.find((x) => x.name === n);
  assert.ok(t, `tool ${n} exists`);
  return t!;
};

test('exposes owner tools plus the editor read tools (each taking a channel)', async () => {
  const { api } = fakeApi();
  const tools = await buildEditorMcpTools(api);
  const names = tools.map((t) => t.name);
  for (const n of ['list_channels', 'get_channel', 'list_plans', 'get_slot', 'list_runs', 'get_run', 'get_spend', 'list_memory', 'replan', 'run_slot', 'set_mode', 'lint_post']) {
    assert.ok(names.includes(n), n);
  }
  for (const n of ['publish_post', 'submit_plan', 'skip_slot']) assert.ok(!names.includes(n), n);
  const lint = byName(tools, 'lint_post');
  assert.deepEqual((lint.inputSchema as any).required, ['channel', 'spec']);
  assert.equal((byName(tools, 'set_mode').inputSchema as any).properties.mode.enum.join(','), 'off,shadow');
});

test('read tools proxy to POST /api/editor/tools/:name with the channel', async () => {
  const { api, calls } = fakeApi();
  const tools = await buildEditorMcpTools(api);
  await byName(tools, 'lint_post').call({ channel: '@space', spec: { format: 'text' } });
  assert.equal(calls.at(-1), 'POST /api/editor/tools/lint_post {"channel":"@space","input":{"spec":{"format":"text"}}}');
  await assert.rejects(byName(tools, 'lint_post').call({ spec: {} }), ToolFailure);
});

test('set_mode: off/shadow only; live is refused without touching the API', async () => {
  const { api, calls } = fakeApi();
  const tools = await buildEditorMcpTools(api);
  const setMode = byName(tools, 'set_mode');
  calls.length = 0;
  await assert.rejects(setMode.call({ channel: '@space', mode: 'live' }), /human-only/);
  assert.deepEqual(calls, []);
  await setMode.call({ channel: '@news', mode: 'shadow' });
  assert.deepEqual(calls, ['GET /api/editor/channels/%40news', 'PUT /api/editor/channels/%40news {"mode":"shadow"}']);
  await assert.rejects(setMode.call({ channel: '@ghost', mode: 'off' }), ToolFailure, 'never creates a card');
});

test('run_slot: shadow channels only unless allowLiveRun is set', async () => {
  const { api, calls } = fakeApi();
  const tools = await buildEditorMcpTools(api);
  await byName(tools, 'run_slot').call({ slot_id: SLOT });
  assert.equal(calls.at(-1), `POST /api/editor/slots/${SLOT}/run?wait=true`);

  calls.length = 0;
  await assert.rejects(byName(tools, 'run_slot').call({ slot_id: '2b4e28ba-2fa1-11d2-883f-0016d3cca427' }), /shadow/);
  assert.ok(!calls.some((c) => c.startsWith('POST')));

  const loose = await buildEditorMcpTools(api, { allowLiveRun: true });
  await byName(loose, 'run_slot').call({ slot_id: '2b4e28ba-2fa1-11d2-883f-0016d3cca427' });
  assert.ok(calls.at(-1)!.endsWith('/run?wait=true'));
});

test('owner reads and replan build the right requests', async () => {
  const { api, calls } = fakeApi();
  const tools = await buildEditorMcpTools(api);
  calls.length = 0;
  await byName(tools, 'list_plans').call({ date: '2026-10-01', channel: '@space' });
  await byName(tools, 'list_runs').call({ channel: '@space', limit: 5 });
  await byName(tools, 'get_spend').call({});
  await byName(tools, 'replan').call({ channel: '@space' });
  assert.deepEqual(calls, [
    'GET /api/editor/plans?date=2026-10-01&channel=%40space',
    'GET /api/editor/runs?channel=%40space&limit=5',
    'GET /api/editor/spend?days=7',
    'POST /api/editor/channels/%40space/replan?wait=true',
  ]);
  await assert.rejects(byName(tools, 'list_plans').call({ date: 'yesterday' }), ToolFailure);
});

test('if the tools endpoint is down, the owner tools are still served', async () => {
  const { api } = fakeApi();
  const broken: EditorApi = { ...api, get: async (p) => { if (p === '/api/editor/tools') throw new Error('ECONNREFUSED'); return api.get(p); } };
  const logs: string[] = [];
  const tools = await buildEditorMcpTools(broken, { log: (m) => logs.push(m) });
  assert.ok(tools.some((t) => t.name === 'list_channels'));
  assert.ok(!tools.some((t) => t.name === 'lint_post'));
  assert.equal(logs.length, 1);
});

test('HttpEditorApi sends the bearer token and turns HTTP errors into ToolFailure', async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    seen.push({ url, init });
    if (url.endsWith('/bad')) return new Response(JSON.stringify({ message: { error: 'slot_not_planned' } }), { status: 409 });
    return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const api = new HttpEditorApi('http://localhost:3000/', 'tok', { fetchImpl });
  assert.deepEqual(await api.put('/api/editor/channels/%40a', { mode: 'off' }), { ok: 1 });
  assert.equal(seen[0].url, 'http://localhost:3000/api/editor/channels/%40a');
  assert.equal(seen[0].init.method, 'PUT');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  assert.equal(seen[0].init.body, '{"mode":"off"}');
  await assert.rejects(api.get('/bad'), (e: Error) => e instanceof ToolFailure && /409/.test(e.message) && /slot_not_planned/.test(e.message));
});
