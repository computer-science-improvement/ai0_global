/**
 * Spec 029 T5 against a throwaway Postgres: rollup and raw reports agree, CSV totals
 * equal the breakdown totals, a price edit and "reprice estimates" change only
 * estimated rows, a cap edit reaches the running gate without a restart, and the
 * Overview agent counts. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { kyivDay } from '../common/ai/usage/kyiv-day';
import { LlmPricesRepository } from '../common/ai/usage/llm-prices.repository';
import { PriceService } from '../common/ai/usage/price.service';
import { LlmBudgetService } from '../common/ai/usage/llm-budget.service';
import { BudgetAlertKeys, LlmBudgetsRepository } from '../common/ai/usage/llm-budgets.repository';
import { LlmUsageRollup } from '../common/ai/usage/llm-usage-rollup';
import { addDays } from './spend-range';
import { SpendRepository, GROUP_BYS } from './spend.repository';
import { SpendService } from './spend.service';
import { OverviewAgentsRepository } from './overview-agents';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const F = 'pgt029t5.';
const RES = 'telegram:@pgt029t5';
const MODEL = 'pgt029t5-model';
const CH = '@pgt029t5';
let pool: Pool;
let rootId: string;
let svc: SpendService;
let repo: SpendRepository;
let prices: PriceService;
let gate: LlmBudgetService;

async function cleanup() {
  await pool.query(`DELETE FROM llm_usage WHERE feature LIKE 'pgt029t5.%'`);
  await pool.query(`DELETE FROM llm_usage_daily WHERE feature LIKE 'pgt029t5.%'`);
  await pool.query(`DELETE FROM llm_prices WHERE model = $1`, [MODEL]);
  await pool.query(`DELETE FROM llm_budgets WHERE scope_key LIKE 'pgt029t5%'`);
  await pool.query(`DELETE FROM llm_budget_alerts WHERE key LIKE '%pgt029t5%'`);
  await pool.query(`DELETE FROM agent_inbox WHERE ref_id LIKE '%pgt029t5%'`).catch(() => {});
  await pool.query(`DELETE FROM agent_directives WHERE body LIKE 'pgt029t5%'`);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agents WHERE handle LIKE 'pgt029t5%'`);
}

/** One ledger row on a Kyiv day (noon). */
async function usage(day: string, o: { provider?: string; model?: string; feature?: string; usd: number | null; source?: string; tin?: number; tout?: number; shadow?: boolean; root?: string | null; status?: string }) {
  await pool.query(
    `INSERT INTO llm_usage (at, provider, model, feature, root_agent_id, role, resource_ref, tokens_in, tokens_out, tokens_cached_read, cost_usd, cost_source, latency_ms, status, shadow)
     VALUES (($1::date::timestamp + interval '12 hours') AT TIME ZONE 'Europe/Kyiv', $2, $3, $4, $5, 'executor', $6, $7, $8, 0, $9, $10, 100, $11, $12)`,
    [day, o.provider ?? 'openrouter', o.model ?? 'z-ai/glm-5.3-flash', o.feature ?? `${F}gen`, o.root === undefined ? rootId : o.root, RES,
      o.tin ?? 1000, o.tout ?? 100, o.usd, o.source ?? 'provider', o.status ?? 'ok', o.shadow ?? false]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  rootId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'network', 'pgt029t5:net', 'T5 root', 'pgt029t5_root', 'approve') RETURNING id`)).rows[0].id;
  repo = new SpendRepository(pool);
  prices = new PriceService(new LlmPricesRepository(pool));
  gate = new LlmBudgetService({ pool, caps: new LlmBudgetsRepository(pool), alertKeys: new BudgetAlertKeys(pool), alert: () => {} });
  svc = new SpendService({ repo, prices, budgets: gate, rollup: new LlmUsageRollup(pool), retentionDays: 90 });
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('reports: the rollup (> 2 days) equals the raw ledger for every group-by; CSV totals equal the breakdown', { skip }, async () => {
  const today = kyivDay();
  for (let i = 0; i < 10; i++) {
    const d = addDays(today, -i);
    await usage(d, { usd: 0.01 * (i + 1) });
    await usage(d, { provider: 'anthropic', model: 'claude-haiku-4-5', feature: `${F}translate`, usd: 0.002, source: 'estimate', root: null });
    if (i % 3 === 0) await usage(d, { usd: 0.005, shadow: true, status: 'error' });
  }
  await new LlmUsageRollup(pool).rollup(12);

  const range = { from: addDays(today, -9), to: today, days: 10 };
  for (const g of GROUP_BYS.filter((x) => x !== 'run')) {
    const a = await repo.aggregate('rollup', range, g, { feature: F });
    const b = await repo.aggregate('raw', range, g, { feature: F });
    const strip = (rows: typeof a) => rows.map((r) => [r.key, r.calls, r.errors, r.tokensIn, r.tokensOut, Number(r.costUsd.toFixed(6)), Number(r.estimatedUsd.toFixed(6))]).sort();
    assert.deepEqual(strip(a), strip(b), `group by ${g}`);
  }

  const bd = await svc.breakdown({ range: '30d', groupBy: 'feature', feature: F });
  assert.equal(bd.source, 'rollup');
  assert.equal(bd.totals.calls, 24);
  assert.equal(bd.totals.costUsd, 0.59);
  assert.equal(bd.totals.errors, 4);
  assert.deepEqual(bd.rows.map((r) => r.key), [`${F}gen`, `${F}translate`]);
  assert.equal(bd.rows[1].estimated, true);
  assert.equal(bd.chart.days.length, 30);
  assert.equal(Number(bd.chart.days.reduce((t, d) => t + d.total, 0).toFixed(6)), 0.59);

  const agent = await svc.breakdown({ range: '30d', groupBy: 'agent', feature: F });
  assert.deepEqual(agent.rows.map((r) => r.label).sort(), ['@pgt029t5_root', 'No agent']);
  const shadow = await svc.breakdown({ range: '30d', groupBy: 'day', feature: F, shadow: true });
  assert.equal(shadow.source, 'raw');
  assert.equal(shadow.totals.calls, 4);
  assert.equal(shadow.totals.noUsageCalls, 0);

  for (const groupBy of ['feature', 'day', 'agent', 'provider']) {
    let csv = '';
    for await (const c of svc.exportCsv(svc.exportPlan({ range: '30d', groupBy, feature: F }))) csv += c;
    const lines = csv.trim().split('\r\n');
    const col = lines[0].split(',').indexOf('usd');
    const sum = lines.slice(1).reduce((t, l) => t + Number(l.split(',')[col]), 0);
    assert.equal(Number(sum.toFixed(6)), 0.59, `csv ${groupBy}`);
  }
  let raw = '';
  for await (const c of svc.exportCsv(svc.exportPlan({ range: '30d', groupBy: 'raw', feature: F }), 7)) raw += c;
  const rawLines = raw.trim().split('\r\n');
  assert.equal(rawLines.length, 1 + 24, 'raw export pages through every row');
  const col = rawLines[0].split(',').indexOf('usd');
  assert.equal(Number(rawLines.slice(1).reduce((t, l) => t + Number(l.split(',')[col]), 0).toFixed(6)), 0.59);
  assert.ok(!/prompt|output/i.test(rawLines[0]), 'no prompt or output text in the export');

  const s = await svc.summary({ range: '7d' });
  assert.ok(s.periods['30d'].usd >= 0.59 - 1e-9);
  assert.ok(s.topFeatures.length > 0);
});

test('a price edit plus "reprice estimates" changes only estimate/unpriced rows and the rollup follows', { skip }, async () => {
  const today = kyivDay();
  const d = addDays(today, -1);
  await usage(d, { provider: 'openai', model: MODEL, feature: `${F}reprice`, usd: null, source: 'unpriced', tin: 2_000_000, tout: 1_000_000 });
  await usage(d, { provider: 'openai', model: MODEL, feature: `${F}reprice`, usd: 1, source: 'estimate', tin: 1_000_000, tout: 0 });
  await usage(d, { provider: 'openai', model: MODEL, feature: `${F}reprice`, usd: 5, source: 'provider', tin: 1_000_000, tout: 0 });
  await usage(d, { provider: 'openai', model: MODEL, feature: `${F}reprice`, usd: 7, source: 'backfill', tin: 1_000_000, tout: 0 });
  await new LlmUsageRollup(pool).rollup(3);
  const before = await svc.breakdown({ range: '7d', groupBy: 'feature', feature: `${F}reprice` });
  assert.equal(before.totals.costUsd, 13);
  assert.equal(before.totals.unpricedCalls, 1);

  assert.equal(await prices.price('openai', MODEL), null);
  await svc.putPrice({ provider: 'openai', model: MODEL, inPerM: 2, outPerM: 10, effectiveFrom: addDays(today, -30) });
  assert.equal((await prices.price('openai', MODEL))?.inPerM, 2, 'the price cache sees the edit at once');

  const r = await svc.reprice({ days: 3 });
  assert.ok(r.repriced >= 2);
  const after = await svc.breakdown({ range: '7d', groupBy: 'feature', feature: `${F}reprice` });
  // unpriced → 2×2 + 1×10 = 14; estimate 1 → 2; provider 5 and backfill 7 unchanged.
  assert.equal(after.totals.costUsd, 28);
  assert.equal(after.totals.unpricedCalls, 0);
  const { rows } = await pool.query(`SELECT cost_source, cost_usd::float8 AS c FROM llm_usage WHERE feature = $1 ORDER BY id`, [`${F}reprice`]);
  assert.deepEqual(rows.map((x) => [x.cost_source, x.c]), [['estimate', 14], ['estimate', 2], ['provider', 5], ['backfill', 7]]);

  const list = await svc.listPrices();
  assert.ok(list.rows.some((p) => p.model === MODEL && p.current));
  await svc.deletePrice({ provider: 'openai', model: MODEL, effectiveFrom: addDays(today, -30) });
  assert.equal(await prices.price('openai', MODEL), null);
});

test('budgets: a new cap blocks at once, raising it unblocks without a restart; blocking caps are listed', { skip }, async () => {
  const today = kyivDay();
  await usage(today, { feature: `${F}cap`, usd: 0.2 });
  const put = await svc.putBudget({ scopeKind: 'feature_prefix', scopeKey: 'pgt029t5.cap', dailyUsd: 0.1 });
  assert.equal(put.created, true);
  const v1 = await gate.checkFeature(`${F}cap.x`, 'openrouter');
  assert.equal(v1.ok, false);
  const view = await svc.budgetsView();
  const row = view.rows.find((b) => b.id === put.id)!;
  assert.equal(row.state, 'blocked');
  assert.equal(row.spentTodayUsd, 0.2);
  assert.ok(view.blocking.some((b) => b.id === String(put.id)));

  await svc.putBudget({ id: put.id, scopeKind: 'feature_prefix', scopeKey: 'pgt029t5.cap', dailyUsd: 5 });
  const v2 = await gate.checkFeature(`${F}cap.x`, 'openrouter');
  assert.equal(v2.ok, true, 'the gate re-read the cap right after the edit');

  await svc.putBudget({ id: put.id, scopeKind: 'feature_prefix', scopeKey: 'pgt029t5.cap', dailyUsd: 0.1, enforce: false });
  assert.equal((await gate.checkFeature(`${F}cap.x`, 'openrouter')).ok, true, 'alert-only rows never block');
  assert.equal((await svc.budgetsView()).rows.find((b) => b.id === put.id)!.state, 'over');

  // The same scope again without an id updates that row instead of adding a duplicate.
  const again = await svc.putBudget({ scopeKind: 'feature_prefix', scopeKey: 'pgt029t5.cap', dailyUsd: 1 });
  assert.deepEqual([again.id, again.created], [put.id, false]);
  const other = await svc.putBudget({ scopeKind: 'feature_prefix', scopeKey: 'pgt029t5.other', dailyUsd: 1 });
  await assert.rejects(svc.putBudget({ id: other.id, scopeKind: 'feature_prefix', scopeKey: 'pgt029t5.cap', dailyUsd: 1 }),
    (e: any) => e.getResponse?.().error === 'scope_exists');
  await svc.deleteBudget(other.id);
  await svc.deleteBudget(put.id);
  assert.equal((await gate.checkFeature(`${F}cap.x`, 'openrouter')).ok, true);
});

test('overview agents: roots by mode and paused, runs, posts and directives', { skip }, async () => {
  const ov = new OverviewAgentsRepository(pool);
  const before = await ov.load();
  const paused = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode, status) VALUES ('orchestrator', 'network', 'pgt029t5:net2', 'T5 paused', 'pgt029t5_paused', 'live', 'paused') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle, mode) VALUES ('executor', 'network', 'pgt029t5:net', $1, 'child', 'pgt029t5_child', 'shadow')`, [rootId]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'approve')`, [CH]);
  for (const st of ['ok', 'ok', 'ok', 'error', 'disabled', 'running']) {
    await pool.query(`INSERT INTO editor_runs (role, channel_key, model, status, agent_id) VALUES ('executor', $1, 'm', $2, $3)`, [CH, st, rootId]);
  }
  await pool.query(`INSERT INTO editor_runs (role, channel_key, model, status, started_at) VALUES ('executor', $1, 'm', 'ok', now() - interval '10 days')`, [CH]);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, (now() AT TIME ZONE 'Europe/Kyiv')::date) RETURNING id`, [CH])).rows[0].id;
  const slot = async (status: string, at: string) => pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status) VALUES ($1, $2, ${at}, 'text', 't', $3)`, [plan, CH, status]);
  await slot('published', 'now()');
  await slot('shadowed', 'now()');
  await slot('published', `now() - interval '3 days'`);
  await slot('awaiting_approval', `now() + interval '3 hours'`);
  await slot('published', `now() - interval '20 days'`);
  await pool.query(
    `INSERT INTO agent_directives (to_agent_id, kind, body, rationale, status) VALUES ($1, 'advice', 'pgt029t5 a', 'r', 'awaiting_owner'), ($1, 'advice', 'pgt029t5 b', 'r', 'new')`, [rootId]);
  await pool.query(
    `INSERT INTO agent_directives (to_agent_id, kind, body, rationale, status, applied_at, outcome) VALUES ($1, 'advice', 'pgt029t5 c', 'r', 'evaluated', now() - interval '2 days', 'worked')`, [rootId]);
  await pool.query(`INSERT INTO agent_directives (to_agent_id, kind, body, rationale, status, shadow) VALUES ($1, 'advice', 'pgt029t5 d', 'r', 'new', true)`, [rootId]);

  const a = await ov.load();
  assert.equal(a.agents.total - before.agents.total, 1, 'children are not root agents');
  assert.equal(a.agents.paused - before.agents.paused, 1);
  assert.equal(a.agents.byMode.live - before.agents.byMode.live, 1);
  assert.equal(a.runs.today - before.runs.today, 6);
  assert.equal(a.runs.d7 - before.runs.d7, 6);
  assert.equal(a.runs.ok7d - before.runs.ok7d, 3);
  assert.equal(a.runs.finished7d - before.runs.finished7d, 5);
  assert.equal(a.runs.disabled7d - before.runs.disabled7d, 1);
  assert.equal(a.posts.today.published - before.posts.today.published, 1);
  assert.equal(a.posts.today.shadowed - before.posts.today.shadowed, 1);
  assert.ok(a.posts.d7.published - before.posts.d7.published >= 1 && a.posts.d7.published - before.posts.d7.published <= 2);
  assert.equal(a.posts.awaitingApproval - before.posts.awaitingApproval, 1);
  assert.equal(a.directives.open - before.directives.open, 2);
  assert.equal(a.directives.awaitingOwner - before.directives.awaitingOwner, 1);
  assert.equal(a.directives.applied30d - before.directives.applied30d, 1);
  assert.equal(a.directives.worked30d - before.directives.worked30d, 1);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [paused]);
});
