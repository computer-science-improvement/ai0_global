/**
 * Spec 029 T4 against a throwaway Postgres: BudgetService parity (ledger vs the old
 * editor_run_steps query), persisted alert dedupe across a restart, the rollup equal
 * to a raw aggregate, and the retention prune. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { BudgetService } from '../../../editor/harness/budget.service';
import { LlmBudgetService, type BlockInfo } from './llm-budget.service';
import { BudgetAlertKeys, LlmBudgetsRepository } from './llm-budgets.repository';
import { LlmUsageRollup, DAILY_SELECT, DAILY_GROUP_BY } from './llm-usage-rollup';
import { EditorRunsRepository } from '../../../editor/repo/editor-runs.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'database', 'migrations', '056_llm_usage.sql'), 'utf8');
const CH = '@pgt029b';
let pool: Pool;
let rootId: string;
let childId: string;

async function cleanup() {
  await pool.query(`DELETE FROM llm_usage WHERE feature LIKE 'pgt029%' OR resource_ref = 'telegram:' || $1 OR run_id IN (SELECT id FROM editor_runs WHERE channel_key = $1)`, [CH]);
  await pool.query(`DELETE FROM llm_usage_daily WHERE feature LIKE 'pgt029%' OR resource_ref = 'telegram:' || $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agents WHERE handle IN ('pgt029b_root', 'pgt029b_exec')`);
  await pool.query(`DELETE FROM llm_budgets WHERE scope_key LIKE 'pgt029%'`);
  await pool.query(`DELETE FROM llm_budget_alerts WHERE key LIKE '%pgt029%'`);
  await pool.query(`DELETE FROM agent_inbox WHERE kind = 'budget_blocked' AND ref_id LIKE '%pgt029%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  rootId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle) VALUES ('orchestrator', 'network', 'pgt029:${CH}', 'B root', 'pgt029b_root') RETURNING id`)).rows[0].id;
  childId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle) VALUES ('executor', 'network', 'pgt029:${CH}', $1, 'B exec', 'pgt029b_exec') RETURNING id`, [rootId])).rows[0].id;
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const OLD_QUERY = `SELECT
   COALESCE(SUM(s.cost_usd) FILTER (WHERE r.channel_key = $1), 0)::float8 AS channel_usd,
   COALESCE(SUM(s.cost_usd) FILTER (WHERE r.agent_id IN (
     SELECT a.id FROM agents a, (SELECT COALESCE(parent_id, id) AS root FROM agents WHERE id = $2) x
      WHERE a.id = x.root OR a.parent_id = x.root)), 0)::float8 AS agent_usd
 FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
 WHERE (r.started_at AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date`;

test('BudgetService parity: channel and agent spend from llm_usage equal the old editor_run_steps query', { skip }, async () => {
  for (const [role, agent, costs] of [['executor', childId, [0.0123, 0.004]], ['planner', rootId, [0.002]], ['reviewer', null, [0.0071]]] as const) {
    const run = (await pool.query(
      `INSERT INTO editor_runs (role, channel_key, model, agent_id, status, cost_usd) VALUES ($1, $2, 'm', $3, 'ok', $4) RETURNING id`,
      [role, CH, agent, costs.reduce((a, b) => a + b, 0)])).rows[0].id;
    for (const [i, c] of costs.entries()) {
      await pool.query(`INSERT INTO editor_run_steps (run_id, idx, type, tool_name, cost_usd) VALUES ($1, $2, $3, $4, $5)`,
        [run, i, i === 0 ? 'llm' : 'tool', i === 0 ? null : 'web_search', c]);
    }
  }
  await pool.query(MIGRATION); // backfills the fixture steps into the ledger (idempotent)

  const old = (await pool.query(OLD_QUERY, [CH, childId])).rows[0];
  const svc = new BudgetService(pool, { globalDailyUsd: 1e9, channelDailyUsd: 1e9 });
  const ch = await svc.check(CH, 1e-9);
  const ag = await svc.check(null, null, { id: childId, limitUsd: 1e-9 });
  assert.equal(ch.ok, false);
  assert.equal(ag.ok, false);
  assert.ok(Math.abs((ch as any).spentUsd - old.channel_usd) < 1e-9, `channel ${(ch as any).spentUsd} vs ${old.channel_usd}`);
  assert.ok(Math.abs((ag as any).spentUsd - old.agent_usd) < 1e-9, `agent ${(ag as any).spentUsd} vs ${old.agent_usd}`);
  assert.ok(Math.abs(old.channel_usd - 0.0254) < 1e-9);
  assert.ok(Math.abs(old.agent_usd - 0.0183) < 1e-9);

  // GET /api/editor/spend source: same per-channel total as editor_runs.cost_usd.
  const spend = (await new EditorRunsRepository(pool).spendByDay(1)).filter((r) => r.channelKey === CH);
  assert.equal(spend.length, 1);
  assert.ok(Math.abs(spend[0].usd - 0.0254) < 1e-9);
  assert.equal(spend[0].runs, 3);
});

test('feature caps alert at 80 % and block at 100 % exactly once per day, also across a restart', { skip }, async () => {
  await pool.query(`INSERT INTO llm_budgets (scope_kind, scope_key, daily_usd) VALUES ('feature_prefix', 'pgt029b.', 0.5), ('feature_prefix', 'pgt029c.', 1)`);
  await pool.query(
    `INSERT INTO llm_usage (provider, model, feature, cost_usd, cost_source) VALUES
       ('anthropic', 'm', 'pgt029b.x', 0.6, 'estimate'), ('anthropic', 'm', 'pgt029c.y', 0.85, 'estimate')`);
  const alerts: string[] = [];
  const blocks: BlockInfo[] = [];
  const make = () => new LlmBudgetService({
    pool, caps: new LlmBudgetsRepository(pool), alertKeys: new BudgetAlertKeys(pool),
    alert: (t) => { alerts.push(t); }, blocked: (b) => { blocks.push(b); },
  });
  const v1 = await make().checkFeature('pgt029b.x', 'anthropic');
  assert.equal(v1.ok, false);
  assert.deepEqual([(v1 as any).key, (v1 as any).capUsd], ['pgt029b.', 0.5]);
  assert.equal((await make().checkFeature('pgt029c.y', 'anthropic')).ok, true);
  // "Restart": fresh instances, same database.
  await make().checkFeature('pgt029b.z', 'anthropic');
  await make().checkFeature('pgt029c.y', 'anthropic');
  assert.equal(blocks.filter((b) => b.key === 'pgt029b.').length, 1);
  assert.equal(alerts.filter((a) => /pgt029c/.test(a)).length, 1);

  // The owner raises the cap → work resumes without a restart (after the caps TTL).
  await pool.query(`UPDATE llm_budgets SET daily_usd = 5 WHERE scope_key = 'pgt029b.'`);
  assert.equal((await make().checkFeature('pgt029b.x', 'anthropic')).ok, true);
});

test('rollup equals the raw aggregate for today and yesterday; prune deletes only rows past retention', { skip }, async () => {
  await pool.query(
    `INSERT INTO llm_usage (at, provider, model, feature, root_agent_id, role, resource_ref, tokens_in, tokens_out, tokens_cached_read, cost_usd, cost_source, status, shadow) VALUES
       (now(),                      'openrouter', 'm1', 'pgt029r.a', $1, 'executor', 'telegram:@r', 100, 10, 5, 0.01, 'provider', 'ok', false),
       (now(),                      'openrouter', 'm1', 'pgt029r.a', $1, 'executor', 'telegram:@r', 200, 20, 0, 0.02, 'estimate', 'error', true),
       (now(),                      'anthropic',  'm2', 'pgt029r.b', NULL, NULL, NULL, 50, 5, NULL, NULL, 'unpriced', 'ok', false),
       (now() - interval '1 day',   'openrouter', 'm1', 'pgt029r.a', $1, 'executor', 'telegram:@r', 300, 30, 0, 0.03, 'provider', 'timeout', false),
       (now() - interval '100 days','openrouter', 'm1', 'pgt029r.old', NULL, NULL, NULL, 1, 1, 0, 1, 'provider', 'ok', false)`, [rootId]);
  const rollup = new LlmUsageRollup(pool, { retentionDays: 90, batchSize: 1 });
  await rollup.rollup();
  await rollup.rollup(); // idempotent recompute
  const cols = `day::text, provider, model, feature, root_agent_id, role, resource_ref, calls, errors, tokens_in::int, tokens_out::int, tokens_cached::int,
                cost_usd::float8, estimated_usd::float8, unpriced_calls, shadow_usd::float8`;
  const { rows: daily } = await pool.query(
    `SELECT ${cols} FROM llm_usage_daily WHERE feature LIKE 'pgt029r.%' AND day > (now() AT TIME ZONE 'Europe/Kyiv')::date - 2 ORDER BY 1, 4, 3`);
  const { rows: raw } = await pool.query(
    `SELECT ${cols} FROM (${DAILY_SELECT} WHERE feature LIKE 'pgt029r.%' AND at >= now() - interval '3 days' ${DAILY_GROUP_BY}) x
      WHERE day > (now() AT TIME ZONE 'Europe/Kyiv')::date - 2 ORDER BY 1, 4, 3`);
  assert.ok(daily.length >= 2);
  assert.deepEqual(daily, raw);
  const today = daily.find((d) => d.feature === 'pgt029r.a' && d.calls === 2);
  assert.deepEqual([today.errors, today.tokens_in, today.tokens_cached, today.estimated_usd, today.shadow_usd], [1, 300, 5, 0.02, 0.02]);
  assert.equal(daily.find((d) => d.feature === 'pgt029r.b').unpriced_calls, 1);

  const pruned = await rollup.prune();
  assert.ok(pruned >= 1);
  const left = (await pool.query(`SELECT feature FROM llm_usage WHERE feature LIKE 'pgt029r.%'`)).rows.map((r) => r.feature);
  assert.ok(!left.includes('pgt029r.old'));
  assert.equal(left.length, 4);
});
