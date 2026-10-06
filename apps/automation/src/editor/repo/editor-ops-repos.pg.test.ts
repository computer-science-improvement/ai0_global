/**
 * Integration tests for the ops-surface repository methods (006) against a
 * throwaway Postgres. Skipped unless EDITOR_PG_TEST_URL is set — see
 * editor-repos.pg.test.ts. Uses its own channel key and only future slots so
 * it cannot interfere with the other pg suites running in parallel.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EditorChannelsRepository } from './editor-channels.repository';
import { EditorPlansRepository } from './editor-plans.repository';
import { EditorMemoryRepository } from './editor-memory.repository';
import { EditorRunsRepository } from './editor-runs.repository';
import { CARD_DEFAULTS } from '../api/card-input';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let pool: Pool;
const CH = '@pgtest_editor_ops';

const cleanup = async () => {
  await pool.query(`DELETE FROM llm_usage WHERE resource_ref = 'telegram:' || $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
};

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('channels.upsert: create, update, and mode changes audited as inactive owner rules', { skip }, async () => {
  const repo = new EditorChannelsRepository(pool);
  const memory = new EditorMemoryRepository(pool);

  const created = await repo.upsert({ channelKey: CH, ...CARD_DEFAULTS, brief: 'перша', hashtags: ['космос'], sources: [{ id: 'f', kind: 'rss', ref: 'https://e.example/feed' }] });
  assert.equal(created.previousMode, null);
  assert.equal(created.card.brief, 'перша');
  assert.deepEqual(created.card.hashtags, ['космос']);
  assert.equal((await memory.listAll(CH)).length, 0, 'created with mode off → nothing to audit');

  const updated = await repo.upsert({ ...created.card, mode: 'shadow', exploreRatio: 0.3, dailyBudgetUsd: 0.25, models: { executor: 'x/y' } });
  assert.equal(updated.previousMode, 'off');
  assert.equal(updated.card.mode, 'shadow');
  assert.equal(updated.card.exploreRatio, 0.3);
  assert.equal(updated.card.dailyBudgetUsd, 0.25);
  assert.deepEqual(updated.card.models, { executor: 'x/y' });

  assert.equal(updated.card.crosspost, true, 'crosspost defaults to true (046)');
  const noMirrors = await repo.upsert({ ...updated.card, crosspost: false, sources: [{ id: 'apod', kind: 'api', ref: 'nasa_apod' }] });
  assert.equal(noMirrors.card.crosspost, false);
  assert.equal((await repo.get(CH))!.crosspost, false);
  assert.deepEqual(noMirrors.card.sources, [{ id: 'apod', kind: 'api', ref: 'nasa_apod' }]);

  await repo.upsert({ ...updated.card, brief: 'друга' }); // same mode → no audit row
  const all = await memory.listAll(CH);
  assert.equal(all.length, 1);
  assert.equal(all[0].text, 'mode changed off→shadow by owner');
  assert.equal(all[0].kind, 'rule');
  assert.equal(all[0].createdBy, 'owner');
  assert.equal(all[0].active, false);
  assert.equal((await memory.listActive(CH)).length, 0, 'audit rows stay out of agent prompts');
});

test('memory: listAll includes retired entries; owner may retire any active entry', { skip }, async () => {
  const memory = new EditorMemoryRepository(pool);
  const a = await memory.add(CH, 'insight', 'reviewer insight', { n: 1 }, 'reviewer');
  const b = await memory.add(CH, 'avoid', 'owner avoid', null, 'owner');
  assert.equal(await memory.retireByOwner(CH, a), true);
  assert.equal(await memory.retireByOwner(CH, a), false, 'already retired');
  assert.equal(await memory.retireByOwner('@other', b), false, 'wrong channel');
  const all = await memory.listAll(CH);
  assert.equal(all[0].id, b, 'active entries first');
  assert.ok(all.some((m) => m.id === a && !m.active));
});

test('plans: claimSlot / skipPlannedSlot only from planned; listPlans and slotStatusCounts', { skip }, async () => {
  const repo = new EditorPlansRepository(pool);
  const future = (h: number) => new Date(Date.now() + h * 3600_000);
  const s = (h: number) => ({ scheduledAt: future(h), format: 'text', topic: `t${h}`, angle: null, sourceHints: [], isExperiment: false });
  const p1 = await repo.createPlan(CH, '2099-02-02', 'old', null, [s(30)]);
  const p2 = await repo.createPlan(CH, '2099-02-02', 'new', null, [s(40), s(41), s(42)]);
  const [a, b, c] = await repo.listSlots(CH, p2);

  const claimed = await repo.claimSlot(a.id);
  assert.equal(claimed!.status, 'running');
  assert.equal(claimed!.attempts, 1);
  assert.equal(await repo.claimSlot(a.id), null, 'cannot claim twice');

  const skipped = await repo.skipPlannedSlot(b.id, 'skipped by owner');
  assert.equal(skipped!.status, 'skipped');
  assert.equal(skipped!.error, 'skipped by owner');
  assert.equal(await repo.skipPlannedSlot(a.id, 'x'), null, 'running slot cannot be skipped');

  const plans = await repo.listPlans('2099-02-02', CH);
  assert.deepEqual(plans.map((p) => [p.id, p.status]), [[p2, 'active'], [p1, 'superseded']]);
  assert.equal(plans[0].planDate, '2099-02-02');
  assert.deepEqual(plans[0].slots.map((x) => x.id), [a.id, b.id, c.id]);
  assert.equal((await repo.listPlans('2099-02-02', '@nobody')).length, 0);

  const counts = (await repo.slotStatusCounts('2099-02-02')).filter((x) => x.channelKey === CH);
  const byStatus = Object.fromEntries(counts.map((x) => [x.status, x.n]));
  assert.deepEqual(byStatus, { running: 1, skipped: 1, planned: 1 }, 'superseded plan is not counted');
});

test('runs: list, get with steps, spend per Kyiv day', { skip }, async () => {
  const runs = new EditorRunsRepository(pool);
  // Spend reads the llm_usage ledger (spec 029): each run gets the ledger row its LLM call would have written.
  const ins = async (startedAt: string, cost: number) => {
    const id = (await pool.query(
      `INSERT INTO editor_runs (role, channel_key, model, status, cost_usd, started_at, finished_at)
       VALUES ('executor', $1, 'm', 'ok', $2, $3, $3) RETURNING id`, [CH, cost, startedAt])).rows[0].id as string;
    await pool.query(
      `INSERT INTO llm_usage (at, provider, model, feature, role, run_id, step_idx, resource_ref, cost_usd, cost_source)
       VALUES ($3, 'openrouter', 'm', 'editor.executor', 'executor', $1, 0, 'telegram:' || $2, $4, 'provider')`, [id, CH, startedAt, cost]);
    return id;
  };
  const today = new Date();
  const r1 = await ins(today.toISOString(), 0.01);
  await ins(today.toISOString(), 0.02);
  await ins(new Date(today.getTime() - 40 * 86_400_000).toISOString(), 5); // outside the 30-day window
  await pool.query(
    `INSERT INTO editor_run_steps (run_id, idx, type, tool_name, input, output, is_error, cost_usd, duration_ms)
     VALUES ($1, 0, 'llm', NULL, NULL, '{"role":"assistant"}', false, 0.01, 50),
            ($1, 1, 'tool', 'lint_post', '{"spec":{}}', '{"ok":true}', false, NULL, 3)`, [r1]);

  const list = await runs.list({ channelKey: CH, limit: 2 });
  assert.equal(list.length, 2);
  assert.ok(list[0].startedAt >= list[1].startedAt);

  const got = await runs.get(r1);
  assert.equal(got!.run.id, r1);
  assert.deepEqual(got!.steps.map((x) => [x.idx, x.type, x.toolName]), [[0, 'llm', null], [1, 'tool', 'lint_post']]);
  assert.equal(got!.steps[0].costUsd, 0.01);
  assert.equal(await runs.get('00000000-0000-0000-0000-000000000000'), null);

  const spend = (await runs.spendByDay(30)).filter((x) => x.channelKey === CH);
  assert.equal(spend.length, 1);
  assert.equal(spend[0].runs, 2);
  assert.ok(Math.abs(spend[0].usd - 0.03) < 1e-9);
  assert.match(spend[0].day, /^\d{4}-\d{2}-\d{2}$/);
});
