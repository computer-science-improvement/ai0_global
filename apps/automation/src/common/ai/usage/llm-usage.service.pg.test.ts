/**
 * LlmUsageService against a throwaway Postgres (spec 029 T2): the batched INSERT,
 * agent snapshots and FK-safe ids. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { LlmUsageService } from './llm-usage.service';
import { LlmPricesRepository } from './llm-prices.repository';
import { BudgetAlertKeys } from './llm-budgets.repository';
import { PriceService } from './price.service';
import { withLlmContext } from './llm-context';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let pool: Pool;
let rootId: string;
let childId: string;

async function cleanup() {
  await pool.query(`DELETE FROM llm_usage WHERE feature LIKE 'pgt029u.%'`);
  await pool.query(`DELETE FROM llm_budget_alerts WHERE key LIKE 'unpriced:anthropic:pgt029u%'`);
  await pool.query(`DELETE FROM agents WHERE handle IN ('pgt029u_root', 'pgt029u_exec')`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  rootId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle) VALUES ('orchestrator', 'resource', 'telegram:@pgt029u', 'U root', 'pgt029u_root') RETURNING id`)).rows[0].id;
  childId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle) VALUES ('executor', 'resource', 'telegram:@pgt029u', $1, 'U exec', 'pgt029u_exec') RETURNING id`, [rootId])).rows[0].id;
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('batched insert: snapshots root/handle, drops dangling run ids, prices from llm_prices, unpriced alert once', { skip }, async () => {
  const alerts: string[] = [];
  const svc = new LlmUsageService({
    pool, prices: new PriceService(new LlmPricesRepository(pool)), alertKeys: new BudgetAlertKeys(pool),
    notify: (t) => { alerts.push(t); }, flushMs: 60_000,
  });
  await withLlmContext({ feature: 'pgt029u.exec', agentId: childId, runId: '99999999-9999-4999-8999-999999999999', stepIdx: 0 }, async () => {
    svc.record({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokensIn: 12_000, tokensOut: 1_500, tokensCachedRead: 8_000, tokensCachedWrite: 2_000 });
  });
  svc.record({ provider: 'anthropic', model: 'pgt029u-model', feature: 'pgt029u.x', tokensIn: 1, tokensOut: 1 });
  svc.record({ provider: 'anthropic', model: 'pgt029u-model', feature: 'pgt029u.x', tokensIn: 1, tokensOut: 1 });
  await svc.flush();
  const { rows: all } = await pool.query(`SELECT * FROM llm_usage WHERE feature LIKE 'pgt029u.%' ORDER BY id`);
  assert.equal(all.length, 3);
  const rows = [all.find((r) => r.feature === 'pgt029u.exec'), ...all.filter((r) => r.feature === 'pgt029u.x')];
  assert.equal(rows[0].agent_id, childId);
  assert.equal(rows[0].root_agent_id, rootId);
  assert.equal(rows[0].agent_handle, 'pgt029u_exec');
  assert.equal(rows[0].run_id, null, 'a run id with no editor_runs row is dropped, not an FK error');
  assert.equal(Number(rows[0].cost_usd), 0.0128);
  assert.equal(rows[0].cost_source, 'estimate');
  assert.equal(rows[1].cost_source, 'unpriced');
  assert.equal(rows[1].cost_usd, null);
  assert.equal(alerts.length, 1);
});
