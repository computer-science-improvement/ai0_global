/** Spec 029 T4: the editor BudgetService on the llm_usage ledger with llm_budgets caps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetService } from './budget.service';
import { AgentLoop } from './agent-loop';
import { FakeLlm, MemoryRecorder } from './testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { LlmBudgetService, type BlockInfo } from '../../common/ai/usage/llm-budget.service';
import type { BudgetRow } from '../../common/ai/usage/llm-budgets.repository';
import { budgetRefusalText, failureText } from '../chat/editor-chat.service';
import { withLlmContext } from '../../common/ai/usage/llm-context';

const row = (p: Partial<BudgetRow>): BudgetRow => ({ id: 1, scopeKind: 'global', scopeKey: '', dailyUsd: 3, monthlyUsd: null, alertPct: 80, enforce: true, ...p });
const DEFAULT_CAPS = [
  row({}), row({ id: 2, scopeKind: 'feature_prefix', scopeKey: 'editor.', dailyUsd: 2 }), row({ id: 3, scopeKind: 'resource', scopeKey: '*', dailyUsd: 0.3 }),
];

function setup(o: { total?: number; editor?: number; chat?: number; channel?: number; agent?: number; caps?: BudgetRow[]; keys?: Set<string> }) {
  const keys = o.keys ?? new Set<string>();
  const blocks: BlockInfo[] = [];
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (/GROUP BY 1, 2/.test(sql)) {
        return { rows: [
          { feature: 'editor.executor', provider: 'openrouter', usd: o.editor ?? 0 },
          { feature: 'editor.chat.composer', provider: 'openrouter', usd: o.chat ?? 0 },
          { feature: 'strategy.s.generate', provider: 'anthropic', usd: (o.total ?? 0) - (o.editor ?? 0) - (o.chat ?? 0) },
        ] };
      }
      return { rows: [{ global_usd: o.editor ?? 0, channel_usd: o.channel ?? 0, agent_usd: o.agent ?? 0, day: '2026-10-06' }] };
    },
  } as any;
  const caps = new LlmBudgetService({
    pool, caps: { list: async () => o.caps ?? DEFAULT_CAPS },
    alertKeys: { claim: async (k) => { if (keys.has(k)) return false; keys.add(k); return true; } },
    alert: () => {}, blocked: (b) => { blocks.push(b); },
  });
  const svc = new BudgetService(pool, { globalDailyUsd: 2, channelDailyUsd: 0.3 }, () => {}, caps);
  return { svc, blocks, keys, queries };
}

test('total AI cap (all spend) blocks the editor before its own caps', async () => {
  const s = setup({ total: 3.2, editor: 0.5 });
  assert.deepEqual(await s.svc.check('ch'), { ok: false, scope: 'total', spentUsd: 3.2, limitUsd: 3 });
  assert.equal(s.blocks.length, 1);
});

test('agents cap (editor.* row) → scope global, as before', async () => {
  const s = setup({ total: 2.1, editor: 2.1 });
  assert.deepEqual(await s.svc.check('ch'), { ok: false, scope: 'global', spentUsd: 2.1, limitUsd: 2 });
});

test('per-resource default cap from llm_budgets ($0.30), a card override wins; blocked once across a restart', async () => {
  const keys = new Set<string>();
  const a = setup({ total: 0.4, editor: 0.4, channel: 0.31, keys });
  assert.deepEqual(await a.svc.check('ch'), { ok: false, scope: 'channel', spentUsd: 0.31, limitUsd: 0.3 });
  assert.equal((await a.svc.check('ch', 1)).ok, true, 'editor_channels.daily_budget_usd override');
  const b = setup({ total: 0.4, editor: 0.4, channel: 0.31, keys }); // restart, same persisted keys
  await b.svc.check('ch');
  assert.equal(a.blocks.length + b.blocks.length, 1);
  assert.deepEqual([a.blocks[0].scope, a.blocks[0].key], ['channel', 'ch']);
});

test('a resource row with enforce = false only alerts', async () => {
  const s = setup({ total: 0.4, editor: 0.4, channel: 0.5, caps: [...DEFAULT_CAPS.slice(0, 2), row({ id: 3, scopeKind: 'resource', scopeKey: '*', dailyUsd: 0.3, enforce: false })] });
  assert.deepEqual(await s.svc.check('ch'), { ok: true });
});

test('agent cap still applies with the ledger; spend query reads llm_usage for the Kyiv day', async () => {
  const s = setup({ total: 0.2, editor: 0.2, channel: 0.1, agent: 0.31 });
  assert.deepEqual(await s.svc.check('ch', null, { id: 'a1', handle: 'kira', limitUsd: 0.3 }), { ok: false, scope: 'agent', spentUsd: 0.31, limitUsd: 0.3 });
  assert.ok(s.queries.some((q) => /FROM llm_usage u/.test(q) && /Europe\/Kyiv/.test(q)));
  assert.equal(s.blocks.at(-1)?.label, 'ліміт агента @kira');
  assert.equal(s.blocks.at(-1)?.labelEn, 'agent cap @kira');
});

test('enforcement returns the caller\'s null path: the AgentLoop ends budget_exceeded before any LLM call', async () => {
  const s = setup({ total: 3.5, editor: 1 });
  const llm = new FakeLlm([{ text: 'never' }]);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: s.svc, enabled: () => true });
  const res = await loop.run({ role: 'composer', channelKey: null, model: resolveModel('composer', () => undefined), system: 's', user: 'u', tools: [] });
  assert.equal(res.status, 'budget_exceeded');
  assert.equal(llm.requests.length, 0);
  // The owner's chat message gets a refusal that names the cap.
  const text = failureText(res);
  assert.match(text, /total daily AI cap \(AI_DAILY_BUDGET_USD\) reached: spent \$3\.500 of \$3/);
  assert.match(text, /Spend → Budgets/);
});

test('budgetRefusalText names each cap', () => {
  assert.match(budgetRefusalText('global budget: $2.1000 >= $2'), /agents daily cap \(EDITOR_DAILY_BUDGET_USD\)/);
  assert.match(budgetRefusalText('channel budget: $0.3100 >= $0.3'), /resource daily cap/);
  assert.match(budgetRefusalText('agent budget: $1.0000 >= $1'), /agent daily cap/);
  assert.match(budgetRefusalText(null), /daily cap/);
});

test('spec 040 FR-001: chat spend has its own pool — it neither counts against nor is blocked by the production caps', async () => {
  const caps = [...DEFAULT_CAPS, row({ id: 4, scopeKind: 'feature_prefix', scopeKey: 'editor.chat', dailyUsd: 1 })];
  const asRun  = (s: ReturnType<typeof setup>, ...a: Parameters<BudgetService['check']>) =>
    withLlmContext({ feature: 'editor.executor' }, () => s.svc.check(...a));
  const asChat = (s: ReturnType<typeof setup>, ...a: Parameters<BudgetService['check']>) =>
    withLlmContext({ feature: 'editor.chat.manager' }, () => s.svc.check(...a));

  // $0.9 of chat on top of $1.9 of production: production is still under its $2 cap.
  const a = setup({ total: 2.8, editor: 1.9, chat: 0.9, caps });
  assert.deepEqual(await asRun(a, 'ch'), { ok: true });
  assert.deepEqual(await asChat(a, null), { ok: true });

  // The chat pool is exhausted: chat stops with the pool named, production runs on.
  const b = setup({ total: 2.6, editor: 1.5, chat: 1.1, caps });
  assert.deepEqual(await asChat(b, null), { ok: false, scope: 'feature', spentUsd: 1.1, limitUsd: 1, key: 'editor.chat' });
  assert.deepEqual(await asRun(b, 'ch'), { ok: true });
  assert.match(budgetRefusalText('feature budget (editor.chat): $1.1000 >= $1'), /agents chat daily cap \(editor\.chat\) reached: spent \$1\.100 of \$1/);

  // Production is exhausted (agents, channel and agent caps): the owner can still talk to the agents.
  const c = setup({ total: 2.2, editor: 2.1, chat: 0.1, channel: 0.5, agent: 9, caps });
  assert.equal((await asRun(c, 'ch')).ok, false);
  assert.deepEqual(await asChat(c, 'ch', null, { id: 'a1', handle: 'kira', limitUsd: 0.3 }), { ok: true });

  // The total AI cap still covers chat.
  const d = setup({ total: 3.1, editor: 1, chat: 0.2, caps });
  assert.deepEqual(await asChat(d, null), { ok: false, scope: 'total', spentUsd: 3.1, limitUsd: 3 });
});

test('spec 040 FR-001: the production spend query leaves chat features out', async () => {
  const s = setup({});
  await withLlmContext({ feature: 'editor.executor' }, () => s.svc.check('ch', null, { id: 'a1', limitUsd: 1 }));
  const q = s.queries.find((x) => /FROM llm_usage u/.test(x))!;
  assert.match(q, /global_usd/);
  assert.equal((q.match(/NOT LIKE 'editor\.chat\.%'/g) ?? []).length, 3, 'agents, channel and agent sums');
});

test('046: the manager / orchestrator / reviewers leave the writer reserve (40% of the agents cap); writers may use it', async () => {
  const s = setup({ total: 1.3, editor: 1.3 });
  const as = (feature: string) => withLlmContext({ feature }, () => s.svc.check('ch'));
  assert.deepEqual(await as('editor.manager'), { ok: false, scope: 'reserve', spentUsd: 1.3, limitUsd: 1.2 });
  assert.equal((await as('editor.orchestrator')).ok, false);
  assert.equal((await as('editor.executor')).ok, true);
  assert.equal((await as('editor.checker')).ok, true);
  assert.equal((await withLlmContext({ feature: 'editor.manager' }, () => setup({ total: 1.1, editor: 1.1 }).svc.check('ch'))).ok, true, 'below the line');
});

test('046: headroom — a whole run must fit under the agents cap', async () => {
  const s = setup({ total: 1.9, editor: 1.9 });
  const v = await withLlmContext({ feature: 'editor.executor' }, () => s.svc.check('ch', 5, null, 'openrouter', { headroomUsd: 0.15 }));
  assert.deepEqual(v, { ok: false, scope: 'headroom', spentUsd: 1.9, limitUsd: 2 });
  assert.equal((await withLlmContext({ feature: 'editor.executor' }, () => s.svc.check('ch', 5))).ok, true, 'a single call still fits');
});
