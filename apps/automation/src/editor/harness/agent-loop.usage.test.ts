/**
 * Spec 029 T3: an editor run end to end (AgentLoop + OpenRouterClient + PgRunRecorder)
 * writes one ledger row per LLM call and per paid tool step, attributed to the run,
 * and the ledger total equals editor_runs.cost_usd (parity).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop } from './agent-loop';
import { defineTool } from './tool';
import { PgRunRecorder } from './run-recorder';
import { FakeBudget } from './testing/fakes';
import { OpenRouterClient } from '../llm/openrouter.client';
import { resolveModel } from '../llm/model-registry';
import { captureUsage } from '../../common/ai/usage/testing';

const RUN = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

const search = defineTool({
  name: 'web_search', description: 'paid', kind: 'read', roles: ['executor'],
  input: z.object({ q: z.string() }), execute: async () => ({ results: [], _costUsd: 0.005 }),
});
const publish = defineTool({
  name: 'publish', description: 'terminal', kind: 'terminal', roles: ['executor'],
  input: z.object({}), execute: async () => ({ ok: true }),
});

function wire(responses: any[], cap: ReturnType<typeof captureUsage>) {
  const runs: any[] = [];
  const pool = {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO editor_runs/.test(sql)) return { rows: [{ id: RUN }] };
      if (/UPDATE editor_runs/.test(sql)) runs.push({ status: params[1], costUsd: params[5] });
      return { rows: [] };
    },
  } as any;
  const http = { post: async () => ({ data: responses.shift() }) };
  const loop = new AgentLoop({
    llm: new OpenRouterClient({ apiKey: 'k', http, sleep: async () => {}, usage: cap.usage }),
    recorder: new PgRunRecorder(pool, () => {}, cap.usage),
    budget: new FakeBudget(),
    enabled: () => true,
  });
  return { loop, runs };
}

const llm = (calls: Array<{ name: string; args: unknown }>, cost: number) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 1000, completion_tokens: 100, cost },
});

test('a shadow executor run: LLM rows + the paid tool row, attributed, summing to the run cost', async () => {
  const cap = captureUsage();
  const { loop, runs } = wire([
    llm([{ name: 'web_search', args: { q: 'x' } }], 0.001),
    llm([{ name: 'publish', args: {} }], 0.0015),
  ], cap);
  const res = await loop.run({
    role: 'executor', channelKey: '@ch', model: resolveModel('executor', () => undefined), system: 's', user: 'u',
    tools: [search, publish], agent: { id: AGENT, handle: 'kira', limitUsd: null },
    extras: { card: { mode: 'shadow' }, orchestrator: { mode: 'live' } },
  });
  assert.equal(res.status, 'ok');
  const rows = await cap.rows();
  assert.equal(rows.length, 3, '2 LLM calls + 1 paid tool step (the free terminal tool has no row)');
  for (const r of rows) {
    assert.equal(r.feature, 'editor.executor');
    assert.equal(r.run_id, RUN);
    assert.equal(r.agent_id, AGENT);
    assert.equal(r.resource_ref, 'telegram:@ch');
    assert.equal(r.shadow, true);
  }
  assert.deepEqual(rows.map((r) => [r.kind, r.provider, r.step_idx]), [['llm', 'openrouter', 0], ['tool', 'tool', 1], ['llm', 'openrouter', 2]]);
  assert.equal(rows[1].model, 'web_search');
  const ledger = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  assert.ok(Math.abs(ledger - runs[0].costUsd) < 1e-9, `ledger ${ledger} = editor_runs.cost_usd ${runs[0].costUsd}`);
});

test('a platform-slot run takes its resource; chat (composer) runs are never shadow; a failed LLM call still writes a row', async () => {
  const cap = captureUsage();
  const { loop } = wire([llm([{ name: 'publish', args: {} }], 0.001)], cap);
  await loop.run({
    role: 'executor', channelKey: '@ch', model: resolveModel('executor', () => undefined), system: 's', user: 'u', tools: [publish],
    extras: { card: { mode: 'live' }, platformSlot: { mode: 'shadow', resourceRef: 'meta:123' } },
  });
  const { loop: chat } = wire([undefined], cap); // the HTTP layer returns no body → "empty response" error
  const res = await chat.run({
    role: 'composer', channelKey: null, model: resolveModel('composer', () => undefined), system: 's', user: 'u', tools: [publish],
    extras: { card: { mode: 'shadow' } },
  });
  assert.equal(res.status, 'error');
  const rows = await cap.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].resource_ref, rows[0].shadow], ['meta:123', true]);
  assert.deepEqual([rows[1].feature, rows[1].shadow, rows[1].status, rows[1].resource_ref], ['editor.composer', false, 'error', null]);
});
