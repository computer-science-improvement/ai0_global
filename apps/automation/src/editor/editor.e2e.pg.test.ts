/**
 * End-to-end (SC-4): planner → plan + slots → claim → executor → shadowed slot
 * with preview, against a real throwaway Postgres and a scripted LLM. Zero
 * network. Skipped unless EDITOR_PG_TEST_URL is set (see repo/*.pg.test.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentLoop } from './harness/agent-loop';
import { ToolRegistry } from './harness/tool-registry';
import { PgRunRecorder } from './harness/run-recorder';
import { BudgetService } from './harness/budget.service';
import { FakeLlm } from './harness/testing/fakes';
import { ReadonlyQueryService } from './db/readonly-query.service';
import { SkillLibrary } from './skills/skill-library';
import { buildReadTools } from './tools/read-tools';
import { buildComposeTools } from './tools/compose-tools';
import { buildRoleTools } from './tools/role-tools';
import { EditorChannelsRepository } from './repo/editor-channels.repository';
import { EditorPlansRepository } from './repo/editor-plans.repository';
import { EditorMemoryRepository } from './repo/editor-memory.repository';
import { EditorRunnerService } from './roles/editor-runner.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@e2e_editor';
const NOW = new Date('2030-03-04T07:00:00Z'); // Monday 09:00 Kyiv (UTC+2)
let pool: Pool;

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(
    `INSERT INTO editor_channels (channel_key, mode, title, brief, formats, hashtags, posts_per_day_min, posts_per_day_max, plan_hour)
     VALUES ($1, 'shadow', 'Космос щодня', 'Короткі пояснення космічних знімків', '{"photo":1,"text":0.5,"quiz":0.3}', '{космос,nasa}', 1, 3, 0)`, [CH]);
  await pool.query(`INSERT INTO editor_channel_memory (channel_key, kind, text, created_by) VALUES ($1, 'rule', 'Не писати про астрологію', 'owner')`, [CH]);
});
after(async () => {
  if (!url) return;
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.end();
});

const SPEC = {
  format: 'photo', title: 'Туманність Кільце від Webb', origin: 'external',
  body: [
    { type: 'lead', text: 'Webb показав туманність Кільце в інфрачервоному світлі' },
    { type: 'p', text: 'Оболонки газу навколо білого карлика — це рештки зорі, схожої на Сонце. Їм кілька тисяч років.' },
  ],
  media: [{ url: 'https://images-assets.nasa.gov/ring.jpg' }],
  hashtags: ['космос'],
  source: { url: 'https://www.nasa.gov/ring-nebula', label: 'NASA' },
};

test('planner → executor in shadow mode', { skip }, async () => {
  let clock = NOW;
  const now = () => clock;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const previews: string[] = [];
  const sent: unknown[] = [];
  const skills = new SkillLibrary();
  const registry = new ToolRegistry([
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
    ...buildComposeTools(),
    ...buildRoleTools({
      pool, plans, memory, channels,
      publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [1] }; } },
      recordPublish: () => {}, notifyPreview: async (_k, html) => { previews.push(html); }, now,
    }),
  ]);

  const llm = new FakeLlm([
    // planner
    { calls: [{ name: 'get_channel_stats', args: { days: 14 } }, { name: 'get_format_performance', args: {} }] },
    { calls: [{ name: 'submit_plan', args: { rationale: 'Один пост у ранковий пік, бо статистики ще немає.', slots: [{ time: '10:00', format: 'photo', topic: 'Знімок туманності Кільце від Webb', source_hints: ['https://www.nasa.gov/ring-nebula'] }] } }] },
    // executor
    { calls: [{ name: 'lint_post', args: { spec: SPEC } }] },
    { calls: [{ name: 'publish_post', args: { spec: SPEC } }] },
  ]);
  const loop = new AgentLoop({
    llm, recorder: new PgRunRecorder(pool), enabled: () => true,
    budget: new BudgetService(pool, { globalDailyUsd: 100, channelDailyUsd: 100 }),
  });
  const runner = new EditorRunnerService({ loop, registry, skills, plans, memory, env: () => undefined, notify: async () => {}, now });

  const card = (await channels.get(CH))!;
  const planRes = await runner.runPlanner(card);
  assert.equal(planRes.terminalTool, 'submit_plan', JSON.stringify(planRes));
  assert.match(llm.requests[0].messages[0].content as string, /Не писати про астрологію/);

  const plan = await plans.getActivePlan(CH, '2030-03-04');
  assert.ok(plan);
  const [slot] = await plans.listSlots(CH, plan!.id);
  assert.equal(slot.scheduledAt.toISOString(), '2030-03-04T08:00:00.000Z');

  clock = new Date('2030-03-04T08:01:00Z');
  const claimed = (await plans.claimDue(clock, 10)).filter((s) => s.channelKey === CH);
  assert.equal(claimed.length, 1);
  const exec = await runner.runExecutor(claimed[0], card);
  assert.equal(exec.terminalTool, 'publish_post', JSON.stringify(exec));

  const after = (await plans.getSlot(slot.id))!;
  assert.equal(after.status, 'shadowed');
  assert.match(after.renderedPreview!, /<b>Webb показав/);
  assert.equal((after.postSpec as any).title, 'Туманність Кільце від Webb');
  assert.equal(after.runId, exec.runId);
  assert.equal(sent.length, 0);
  assert.equal(previews.length, 1);

  const { rows } = await pool.query(`SELECT role, status, steps, cost_usd FROM editor_runs WHERE channel_key = $1 ORDER BY started_at`, [CH]);
  assert.deepEqual(rows.map((r) => [r.role, r.status]), [['planner', 'ok'], ['executor', 'ok']]);
  assert.ok(rows.every((r) => Number(r.steps) >= 3 && Number(r.cost_usd) > 0));
  const steps = await pool.query(`SELECT COUNT(*)::int AS n FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id WHERE r.channel_key = $1`, [CH]);
  assert.ok(steps.rows[0].n >= 7);
});
