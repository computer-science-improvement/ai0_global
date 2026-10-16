import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildComposeTools } from './compose-tools';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { lintFailed } from '../post/lint-post';
import { AgentLoop } from '../harness/agent-loop';
import { defineTool } from '../harness/tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { buildAgentChatTools, slotScopeOf } from '../agents/agent-chat-tools';
import { resourcesBlock } from '../network/network-prompts';

/** Spec 040 FR-008 / FR-016: honest metrics and small fixes. */

test('FR-008: a failed lint is a tool error (lint_failed) with its errors as details; a clean one is unchanged', async () => {
  assert.deepEqual(lintFailed({ ok: true, errors: [], warnings: [] }), { ok: true, errors: [], warnings: [] });
  const bad: any = lintFailed({ ok: false, errors: [{ code: 'too_long', message: 'caption over 2200' }], warnings: [] });
  assert.equal(bad.error, 'lint_failed');
  assert.deepEqual(bad.details, ['too_long: caption over 2200']);
  assert.equal(bad.errors.length, 1, 'the model still sees the errors');

  const tools = Object.fromEntries(buildComposeTools().map((t) => [t.name, t]));
  const ctx: any = { runId: 'r', role: 'executor', channelKey: '@chan', extras: { card: makeCard() } };
  const r: any = await tools.lint_post.execute({ spec: makeSpec({ format: 'poll' } as any) }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'lint_failed');
  assert.equal(tools.lint_post.keepOnError, true);
});

test('FR-008: the breaker never drops a keepOnError tool (a lint judges the post, not the call)', async () => {
  const lint = defineTool({
    name: 'lint', description: 'lint', kind: 'read', roles: ['composer'], keepOnError: true,
    input: z.object({ v: z.number() }), execute: async ({ v }) => ({ error: 'lint_failed', details: [`v${v}`] }),
  });
  const finish = defineTool({ name: 'finish', description: 't', kind: 'terminal', roles: ['composer'], input: z.object({}), execute: async () => ({ ok: true }) });
  const llm = new FakeLlm([
    { calls: [{ name: 'lint', args: { v: 1 } }] }, { calls: [{ name: 'lint', args: { v: 2 } }] }, { calls: [{ name: 'lint', args: { v: 3 } }] },
    { calls: [{ name: 'lint', args: { v: 4 } }] }, { calls: [{ name: 'finish', args: {} }] },
  ]);
  const recorder = new MemoryRecorder();
  const res = await new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true })
    .run({ role: 'composer', channelKey: null, model: resolveModel('composer', () => undefined), system: 's', user: 'u', tools: [lint, finish] });
  assert.equal(res.status, 'ok');
  assert.ok(llm.requests[4].tools!.some((t) => t.name === 'lint'));
  assert.deepEqual(recorder.runs[0].breaker, { repeatBlocked: 0, toolsDropped: [] });
  assert.equal(recorder.steps.filter((x) => x.tool === 'lint' && x.isError).length, 4, 'every failed lint counts as an error');
});

test('FR-016: explain_decision takes telegram:@x, @x, x and platform refs', async () => {
  assert.deepEqual(slotScopeOf('telegram:@space'), { channelKey: '@space', resourceRef: 'telegram:@space' });
  assert.deepEqual(slotScopeOf('@space'), { channelKey: '@space', resourceRef: 'telegram:@space' });
  assert.deepEqual(slotScopeOf('space'), { channelKey: '@space', resourceRef: 'telegram:@space' });
  assert.deepEqual(slotScopeOf('instagram:ig1'), { channelKey: null, resourceRef: 'instagram:ig1' });
  assert.deepEqual(slotScopeOf(''), { channelKey: null, resourceRef: null });

  const queries: any[] = [];
  const pool = { query: async (sql: string, params: any[]) => { queries.push([sql, params]); return { rows: [] }; } };
  const tool = buildAgentChatTools({ pool } as any).find((t) => t.name === 'explain_decision')!;
  const r: any = await tool.execute({ channel: 'telegram:@space', date: '2026-10-16' }, { runId: 'r', role: 'manager', channelKey: null, extras: {} } as any);
  assert.deepEqual(queries[0][1], [null, '@space', '2026-10-16', 'telegram:@space']);
  assert.match(r.note, /немає активного плану/);
  const none: any = await tool.execute({}, { runId: 'r', role: 'manager', channelKey: null, extras: {} } as any);
  assert.equal(none.error, 'no_channel');
});

test('FR-016: the network context names the resources left out of the run', () => {
  const text = resourcesBlock({
    resources: [{ ref: 'telegram:@space', platform: 'telegram' }], telegramFormats: ['text'],
    dropped: [{ ref: 'instagram:ig1', reason: 'unusable' }, { ref: 'threads:th1', reason: 'paused' }],
  } as any);
  assert.match(text, /instagram:ig1: зараз поза мережею \(недоступний: токен чи права\)/);
  assert.match(text, /threads:th1: зараз поза мережею \(на паузі за директивою\)/);
});
