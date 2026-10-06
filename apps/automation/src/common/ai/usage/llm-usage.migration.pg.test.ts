/**
 * Migration 056 (spec 029 T1) against a throwaway Postgres with all migrations applied:
 * idempotency on production-shaped editor data, backfill row count and the parity query.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { LlmPricesRepository } from './llm-prices.repository';
import { LlmBudgetsRepository, BudgetAlertKeys } from './llm-budgets.repository';
import { PriceService } from './price.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'database', 'migrations', '056_llm_usage.sql'), 'utf8');
const CH = '@pgt029';
let pool: Pool;
const runIds: string[] = [];
let rootId: string;
let childId: string;

async function cleanup() {
  await pool.query(`DELETE FROM llm_usage WHERE run_id IN (SELECT id FROM editor_runs WHERE channel_key = $1 OR model = 'pgt029-model')`, [CH]);
  await pool.query(`DELETE FROM llm_usage_daily WHERE model IN ('pgt029-model', 'pgt029_search')`);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1 OR model = 'pgt029-model'`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agents WHERE handle IN ('pgt029_root', 'pgt029_exec') OR scope_id = 'telegram:' || $1::text`, [CH]);
  await pool.query(`DELETE FROM llm_budgets WHERE seeded_from = 'pgt029'`);
  await pool.query(`DELETE FROM llm_budget_alerts WHERE key LIKE 'pgt029:%'`);
}

async function run(role: string, channel: string | null, agentId: string | null, slotId: string | null, steps: Array<{ type: 'llm' | 'tool'; cost: number | null; tool?: string; tokens?: [number, number] }>) {
  const cost = steps.reduce((s, x) => s + (x.cost ?? 0), 0);
  const { rows } = await pool.query(
    `INSERT INTO editor_runs (role, channel_key, slot_id, model, agent_id, status, steps, cost_usd, finished_at)
     VALUES ($1, $2, $3, 'pgt029-model', $4, 'ok', $5, $6, now()) RETURNING id`,
    [role, channel, slotId, agentId, steps.length, cost]);
  const id = rows[0].id as string;
  for (const [i, s] of steps.entries()) {
    await pool.query(
      `INSERT INTO editor_run_steps (run_id, idx, type, tool_name, prompt_tokens, completion_tokens, cost_usd, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100)`,
      [id, i, s.type, s.tool ?? null, s.tokens?.[0] ?? null, s.tokens?.[1] ?? null, s.cost]);
  }
  runIds.push(id);
  return id;
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  rootId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'network', 'pgt029:${CH}', 'PG root', 'pgt029_root', 'shadow') RETURNING id`)).rows[0].id;
  childId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle) VALUES ('executor', 'network', 'pgt029:${CH}', $1, 'PG exec', 'pgt029_exec') RETURNING id`, [rootId])).rows[0].id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'shadow')`, [CH]);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [CH])).rows[0].id;
  const slot = (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status) VALUES ($1, $2, now(), 'text', 't', 'shadowed') RETURNING id`, [plan, CH])).rows[0].id;
  await run('executor', CH, childId, slot, [
    { type: 'llm', cost: 0.001234, tokens: [25_000, 2_000] },
    { type: 'tool', cost: 0.002, tool: 'pgt029_search' },
    { type: 'tool', cost: null, tool: 'lint_post' },
    { type: 'llm', cost: 0.0005, tokens: [26_000, 300] },
  ]);
  await run('planner', null, null, null, [
    { type: 'llm', cost: 0.003, tokens: [14_000, 1_000] },
    { type: 'tool', cost: null, tool: 'list_slots' },
  ]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('056: re-applying the migration is idempotent and backfills LLM + costed tool steps once', { skip }, async () => {
  await pool.query(MIGRATION);
  const count = async () => Number((await pool.query(`SELECT COUNT(*) FROM llm_usage WHERE run_id = ANY($1::uuid[])`, [runIds])).rows[0].count);
  const expected = Number((await pool.query(
    `SELECT COUNT(*) FROM editor_run_steps WHERE run_id = ANY($1::uuid[]) AND (type = 'llm' OR cost_usd IS NOT NULL)`, [runIds])).rows[0].count);
  assert.equal(expected, 4);
  assert.equal(await count(), expected);
  await pool.query(MIGRATION);
  assert.equal(await count(), expected, 'second apply adds nothing');
});

test('056 backfill: attribution snapshots, tool rows, shadow and cost_source', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT u.* FROM llm_usage u WHERE run_id = ANY($1::uuid[]) ORDER BY run_id = $2 DESC, step_idx`, [runIds, runIds[0]]);
  const [llm0, tool1, llm3, planner] = rows;
  assert.equal(llm0.feature, 'editor.executor');
  assert.equal(llm0.provider, 'openrouter');
  assert.equal(llm0.model, 'pgt029-model');
  assert.equal(llm0.agent_id, childId);
  assert.equal(llm0.root_agent_id, rootId);
  assert.equal(llm0.agent_handle, 'pgt029_exec');
  assert.equal(llm0.resource_ref, `telegram:${CH}`);
  assert.equal(llm0.tokens_in, 25_000);
  assert.equal(llm0.cost_source, 'backfill');
  assert.equal(llm0.shadow, true, 'run of a shadowed slot');
  assert.equal(tool1.kind, 'tool');
  assert.equal(tool1.provider, 'tool');
  assert.equal(tool1.model, 'pgt029_search');
  assert.equal(Number(tool1.cost_usd), 0.002);
  assert.equal(llm3.step_idx, 3);
  assert.equal(planner.feature, 'editor.planner');
  assert.equal(planner.resource_ref, null);
  assert.equal(planner.root_agent_id, null);
  assert.equal(planner.shadow, false);
});

test('parity: llm_usage USD per Kyiv day equals editor_runs.cost_usd for editor features', { skip }, async () => {
  const { rows } = await pool.query(
    `WITH runs AS (
       SELECT (started_at AT TIME ZONE 'Europe/Kyiv')::date AS day, SUM(cost_usd) AS usd FROM editor_runs WHERE id = ANY($1::uuid[]) GROUP BY 1),
     ledger AS (
       SELECT (r.started_at AT TIME ZONE 'Europe/Kyiv')::date AS day, SUM(u.cost_usd) AS usd
         FROM llm_usage u JOIN editor_runs r ON r.id = u.run_id
        WHERE u.run_id = ANY($1::uuid[]) AND u.feature LIKE 'editor.%' GROUP BY 1)
     SELECT runs.day, runs.usd::float8 AS runs_usd, COALESCE(ledger.usd, 0)::float8 AS ledger_usd
       FROM runs LEFT JOIN ledger USING (day)`, [runIds]);
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.ok(Math.abs(r.runs_usd - r.ledger_usd) < 0.0001, `${r.day}: ${r.runs_usd} vs ${r.ledger_usd}`);
});

test('the one-time rollup covers the backfilled rows', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT SUM(cost_usd)::float8 AS usd, SUM(calls)::int AS calls FROM llm_usage_daily WHERE model IN ('pgt029-model', 'pgt029_search')`);
  assert.equal(rows[0].calls, 4);
  assert.ok(Math.abs(rows[0].usd - (0.001234 + 0.002 + 0.0005 + 0.003)) < 1e-9);
});

test('seeded prices load through PriceService; budgets seed once; alert keys claim once', { skip }, async () => {
  const prices = new PriceService(new LlmPricesRepository(pool));
  const p = await prices.price('anthropic', 'claude-haiku-4-5-20251001');
  assert.equal(p?.cachedReadPerM, 0.1);
  assert.equal((await prices.price('openrouter', 'z-ai/glm-5.3'))?.outPerM, 3.39);

  const budgets = new LlmBudgetsRepository(pool);
  const seed = [{ scopeKind: 'provider' as const, scopeKey: 'pgt029', dailyUsd: 1.5, seededFrom: 'pgt029' }];
  assert.equal(await budgets.seed(seed), 1);
  await pool.query(`UPDATE llm_budgets SET daily_usd = 9 WHERE scope_key = 'pgt029'`);
  assert.equal(await budgets.seed([{ ...seed[0], dailyUsd: 2 }]), 0, 'an existing (owner-edited) row is never overwritten');
  const row = (await budgets.list()).find((b) => b.scopeKey === 'pgt029');
  assert.equal(row?.dailyUsd, 9);
  assert.equal(row?.enforce, true, 'blocking by default');
  assert.equal(row?.alertPct, 80);

  const keys = new BudgetAlertKeys(pool);
  assert.equal(await keys.claim('pgt029:a'), true);
  assert.equal(await keys.claim('pgt029:a'), false);
});
