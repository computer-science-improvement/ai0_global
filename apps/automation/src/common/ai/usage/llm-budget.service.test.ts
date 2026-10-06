import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmBudgetService, capDefaults, capSeeds, envNum, type BlockInfo } from './llm-budget.service';
import { BudgetExceededError } from './llm-usage.service';
import { blockedNotifier } from './llm-usage.module';
import type { BudgetRow } from './llm-budgets.repository';

const row = (p: Partial<BudgetRow>): BudgetRow => ({ id: 1, scopeKind: 'global', scopeKey: '', dailyUsd: 3, monthlyUsd: null, alertPct: 80, enforce: true, ...p });

/** Shared "DB": persisted alert keys survive a new service instance (a restart). */
function world(spend: Array<{ feature: string; provider: string; usd: number }>, caps: BudgetRow[]) {
  const keys = new Set<string>();
  const alerts: string[] = [];
  const blocks: BlockInfo[] = [];
  const state = { spend, caps, failSpend: false, t: 0 };
  const make = () => new LlmBudgetService({
    pool: { query: async () => { if (state.failSpend) throw new Error('db down'); return { rows: state.spend }; } } as any,
    caps: { list: async () => state.caps },
    alertKeys: { claim: async (k) => { if (keys.has(k)) return false; keys.add(k); return true; } },
    alert: (t) => { alerts.push(t); },
    blocked: (b) => { blocks.push(b); },
    capsTtlMs: 1000, now: () => state.t,
  });
  return { state, keys, alerts, blocks, make };
}

test('env defaults (empty = default) and the seeds they produce', () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assert.deepEqual(capDefaults(env({})), { totalDailyUsd: 3, agentsDailyUsd: 2, resourceDailyUsd: 0.3 });
  assert.deepEqual(capDefaults(env({ AI_DAILY_BUDGET_USD: ' ', EDITOR_DAILY_BUDGET_USD: '5', EDITOR_CHANNEL_DAILY_BUDGET_USD: '' })),
    { totalDailyUsd: 3, agentsDailyUsd: 5, resourceDailyUsd: 0.3 });
  assert.equal(envNum(env({ X: '0' }), 'X', 9), 0, 'an explicit 0 is kept');
  assert.deepEqual(capSeeds(capDefaults(env({}))).map((s) => [s.scopeKind, s.scopeKey, s.dailyUsd]),
    [['global', '', 3], ['feature_prefix', 'editor.', 2], ['resource', '*', 0.3]]);
});

test('total cap blocks every feature; one block notification per day, also across a restart', async () => {
  const w = world([{ feature: 'strategy.s1.generate', provider: 'anthropic', usd: 2.5 }, { feature: 'editor.executor', provider: 'openrouter', usd: 0.6 }], [row({})]);
  const v = await w.make().checkFeature('dm.triage', 'anthropic');
  assert.deepEqual(v, { ok: false, scope: 'total', key: '', label: 'загальний ліміт AI (AI_DAILY_BUDGET_USD)', labelEn: 'total AI cap (AI_DAILY_BUDGET_USD)', spentUsd: 3.1, capUsd: 3 });
  await w.make().checkFeature('dm.triage', 'anthropic');      // a "restart": new instance, same persisted keys
  await w.make().assertWithin('tracking.roi', 'anthropic').catch(() => {});
  assert.equal(w.blocks.length, 1);
  assert.equal(w.alerts.length, 0, 'the 80 % alert is skipped once already over the cap');
  await assert.rejects(w.make().assertWithin('x', 'openai'), (e: any) => e instanceof BudgetExceededError && e.scope === 'total');
});

test('alert at alert_pct once, then the 100 % block once', async () => {
  const w = world([{ feature: 'strategy.a.generate', provider: 'anthropic', usd: 0.85 }], [row({ scopeKind: 'feature_prefix', scopeKey: 'strategy.', dailyUsd: 1 })]);
  const svc = w.make();
  assert.deepEqual(await svc.checkFeature('strategy.a.generate', 'anthropic'), { ok: true });
  assert.deepEqual(await svc.checkFeature('strategy.b.generate', 'anthropic'), { ok: true });
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], /80%/);
  w.state.spend = [{ feature: 'strategy.a.generate', provider: 'anthropic', usd: 1.01 }];
  const v = await w.make().checkFeature('strategy.c.generate', 'anthropic');
  assert.equal(v.ok, false);
  assert.equal((v as any).scope, 'feature');
  await w.make().checkFeature('strategy.c.generate', 'anthropic');
  assert.equal(w.blocks.length, 1);
  assert.equal(w.alerts.length, 1);
  assert.deepEqual(await w.make().checkFeature('editor.executor', 'openrouter'), { ok: true }, 'a prefix cap covers only its features');
});

test('enforce = false is alert-only', async () => {
  const w = world([{ feature: 'dm.triage', provider: 'anthropic', usd: 2 }], [row({ scopeKind: 'provider', scopeKey: 'anthropic', dailyUsd: 1, enforce: false })]);
  assert.deepEqual(await w.make().checkFeature('dm.triage', 'anthropic'), { ok: true });
  await w.make().checkFeature('dm.triage', 'anthropic');
  assert.equal(w.blocks.length, 0);
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], /лише сповіщення/);
  assert.deepEqual(await w.make().checkFeature('dm.triage', 'openai'), { ok: true }, 'a provider cap covers only its provider');
});

test('the narrowest exhausted cap is named; provider spend is summed per provider', async () => {
  const w = world([
    { feature: 'strategy.a.generate', provider: 'anthropic', usd: 1.2 },
    { feature: 'text.format', provider: 'anthropic', usd: 0.5 },
    { feature: 'text.summarize', provider: 'perplexity', usd: 0.9 },
  ], [row({ dailyUsd: 2 }), row({ id: 2, scopeKind: 'provider', scopeKey: 'anthropic', dailyUsd: 1.5 })]);
  const v = await w.make().checkFeature('text.format', 'anthropic');
  assert.equal(v.ok, false);
  assert.deepEqual([(v as any).scope, (v as any).spentUsd], ['provider', 1.7]);
});

test('raising the cap resumes work after the caps TTL; a new Kyiv day resets the window', async () => {
  const w = world([{ feature: 'x', provider: 'openai', usd: 3.5 }], [row({})]);
  const svc = w.make();
  assert.equal((await svc.checkFeature('x', 'openai')).ok, false);
  w.state.caps = [row({ dailyUsd: 10 })];
  assert.equal((await svc.checkFeature('x', 'openai')).ok, false, 'cached caps until the TTL');
  w.state.t = 1500;
  assert.equal((await svc.checkFeature('x', 'openai')).ok, true, 'the owner raised the cap');
  svc.invalidate();
  w.state.caps = [row({ dailyUsd: 3 })];
  w.state.spend = []; // after Kyiv midnight the day's spend starts from 0
  assert.equal((await svc.checkFeature('x', 'openai')).ok, true);
});

test('a failing spend read fails open; no caps → no query', async () => {
  const w = world([], [row({})]);
  w.state.failSpend = true;
  await w.make().assertWithin('x', 'openai');
  const none = world([], []);
  none.state.failSpend = true;
  assert.deepEqual(await none.make().checkFeature('x', 'openai'), { ok: true });
});

test('resourceCap: a concrete resource row wins over the * default', async () => {
  const w = world([], [row({ scopeKind: 'resource', scopeKey: '*', dailyUsd: 0.3 }), row({ id: 2, scopeKind: 'resource', scopeKey: 'telegram:@big', dailyUsd: 1 })]);
  const svc = w.make();
  assert.equal((await svc.resourceCap('telegram:@big'))?.capUsd, 1);
  assert.equal((await svc.resourceCap('telegram:@other'))?.capUsd, 0.3);
});

test('blockedNotifier posts one critical budget_blocked Inbox entry with scope, spend and cap (English; the Telegram alert keeps its wording)', async () => {
  const posted: any[] = [];
  await blockedNotifier({ post: async (i: any) => { posted.push(i); return 1; } })({ scope: 'total', key: '', label: 'загальний ліміт AI (AI_DAILY_BUDGET_USD)', labelEn: 'total AI cap (AI_DAILY_BUDGET_USD)', spentUsd: 3.1234, capUsd: 3 });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'budget_blocked');
  assert.equal(posted[0].severity, 'critical');
  assert.equal(posted[0].title, '💸 LLM budget exhausted: total AI cap (AI_DAILY_BUDGET_USD)');
  assert.match(posted[0].body, /Spent \$3\.123 of \$3 today/);
  assert.match(posted[0].body, /until midnight Kyiv time/);
  assert.match(posted[0].alert.title, /Бюджет LLM вичерпано: загальний ліміт AI/);
  assert.match(posted[0].alert.body, /\$3\.123 із \$3/);
  assert.match(posted[0].alert.body, /опівночі за Києвом/);
});
