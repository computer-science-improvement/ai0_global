/** Spec 021 on a throwaway Postgres: KPI digest from real tables and the directive lifecycle. Skipped unless EDITOR_PG_TEST_URL is set. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { DirectivesRepository } from './directives.repository';
import { KpiDigestService } from './kpi-digest.service';
import { ManagerRunner } from './manager-runner';
import { fileDirective } from './directive-tools';
import { ManagerService } from './manager.service';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { NetworkRepository } from '../network/network.repository';
import { DirectiveExecution, executionContextOf, formatShiftExecutor, frequencyExecutor, pauseSeriesExecutor, SqlPlanObserver } from './executors';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@kpi_pg_test';
const REF = `telegram:${CH}`;
let pool: Pool;
let orchId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE scope_id = $1)`, [REF]);
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [REF]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM kpi_snapshots WHERE scope_id = $1`, [REF]);
  await pool.query(`DELETE FROM manager_reviews WHERE summary LIKE 'kpi-pg%'`);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, 'kpi_pg_test', 'KPI', true)`, [CH]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, posts_per_day_min, posts_per_day_max) VALUES ($1, 'live', 2, 6)`, [CH]);
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'KPI', handle: 'kpi_pg_orch', mode: 'live', createdBy: 'owner' })).id;
  // 35 days of posts: 1000 views/post in the baseline, 500 in the last week (a 50% drop).
  for (let d = 2; d <= 35; d++) {
    const { rows } = await pool.query(
      `INSERT INTO published_posts (channel_id, message_id, title, format, posted_at) VALUES ($1, $2, 'Пост', 'photo', now() - ($3 || ' days')::interval) RETURNING id`,
      [CH, 1000 + d, String(d)]);
    await pool.query(`INSERT INTO post_stats_snapshots (post_id, views, forwards, reactions_total) VALUES ($1, $2, 3, 10)`, [rows[0].id, d <= 8 ? 500 + d : 1000 + d * 3]);
  }
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('digest flags the drop; directive lifecycle: owner approval → delivery → accept → applied → evaluated', { skip }, async () => {
  const catalog = { list: async () => [{ ref: REF, platform: 'telegram' as const, title: 'KPI', username: 'kpi_pg_test', followers: null, groupId: null, groupName: null, agent: 'kpi_pg_orch' }] };
  const digest = new KpiDigestService({ pool, catalog, globalCapUsd: 3 });
  const dg = await digest.build();
  const r = dg.resources.find((x) => x.ref === REF)!;
  assert.ok(r.anomalies.includes('views_per_post'), JSON.stringify(r.kpis));
  assert.ok((r.kpis.views_per_post.d ?? 0) < -40);
  assert.ok(digest.render(dg).length <= 12_000);
  assert.equal(await digest.snapshot(dg), 1);

  const agents = new AgentsRepository(pool);
  const repo = new DirectivesRepository(pool);
  const inbox = new OwnerInbox(pool);
  // Spec 025: the real executors; this orchestrator has no playbook, so frequency edits its card (single-channel fallback).
  const channels = new EditorChannelsRepository(pool);
  const network = new NetworkRepository(pool);
  const xdeps = { network, channels, observer: new SqlPlanObserver(pool) };
  const exec = new DirectiveExecution({
    repo, inbox, agents, context: executionContextOf({ repo: network, channels }),
    executors: [frequencyExecutor(xdeps), formatShiftExecutor(xdeps), pauseSeriesExecutor(xdeps)],
  });
  const deps = {
    repo, agents, digest, inbox, memory: { listActive: async () => [] }, actions: { propose: async () => ({}) as any },
    channelKeyOf: async () => CH, exec,
  };
  const filed: any = await fileDirective(deps as any, {
    to: '@kpi_pg_orch', kind: 'frequency', binding: 'directive', body: 'Зменшити частоту на 40% на тиждень', params: { change_pct: -40 },
    rationale: 'Перегляди на пост впали на 50% за тиждень', evidence: { views_per_post: r.kpis.views_per_post },
    expected: { metric: 'views_per_post', direction: 'up', min_change_pct: 10 }, review_in_days: 3,
  }, { from: null, runId: null, shadow: false, digest: dg });
  assert.equal(filed.directive.status, 'awaiting_owner');

  const svc = new ManagerService({ repo, agents, digest, runner: { run: async () => ({}) as any, manager: async () => null } as any });
  await svc.decide(filed.directive.id, true);
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents, repo, digest, inbox, env: () => undefined, exec,
  });
  const orch = (await agents.get(orchId))!;
  const text = await runner.deliver(orch);
  assert.match(text!, /Зменшити частоту на 40%/);
  assert.equal(await runner.deliver(orch) !== null, true, 'still listed until resolved');
  assert.ok((await repo.get(filed.directive.id))!.deliveredAt);

  await repo.update(filed.directive.id, { status: 'accepted', resolution: 'Зменшу до 2 постів на день' }, ['new']);
  const applied = await runner.afterOrchestration(orch, dg);
  assert.equal(applied.length, 1);
  const a = (await repo.get(filed.directive.id))!;
  assert.equal(a.status, 'applied');
  assert.ok(a.outcomeDetail?.before?.value != null);
  // The executor changed the card: 2–6 posts a day, −40 % → 1–4 (rounded); the change holds before/after.
  assert.deepEqual([a.change.target, a.change.before, a.change.after], ['card', { min: 2, max: 6 }, { min: 1, max: 4 }]);
  const card = (await channels.get(CH))!;
  assert.deepEqual([card.postsPerDayMin, card.postsPerDayMax], [1, 4]);

  // Spec 025 FR-016: only a verified change is scored — the next plan keeps the channel within 1–4 posts.
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date + 1) RETURNING id`, [CH])).rows[0].id;
  for (const h of ['10:00', '15:00']) {
    await pool.query(`INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic) VALUES ($1, $2, (current_date + 1 + $3::time) AT TIME ZONE 'Europe/Kyiv', 'photo', 't')`, [plan, CH, h]);
  }
  assert.equal(await exec.verifyApplied(), 1);
  assert.ok((await repo.get(a.id))!.verifiedAt);
  // Review date reached; the metric recovered by > 10% → worked.
  await pool.query(`UPDATE agent_directives SET review_at = now() - interval '1 minute' WHERE id = $1`, [a.id]);
  await pool.query(`UPDATE post_stats_snapshots SET views = 900 WHERE post_id IN (SELECT id FROM published_posts WHERE channel_id = $1 AND posted_at > now() - interval '8 days')`, [CH]);
  assert.equal(await runner.evaluate(), 1);
  const e = (await repo.get(a.id))!;
  assert.equal(e.status, 'evaluated');
  assert.equal(e.outcome, 'worked', JSON.stringify(e.outcomeDetail));
});
