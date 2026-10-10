/**
 * Spec 034 T7 (FR-012 / FR-013) on a throwaway Postgres with scripted LLMs (no network, no publishing):
 * - migration 070 is idempotent;
 * - `POST /api/editor/slots/:id/preview` (EditorOpsService → runner → real publish tools) stores a dry-run
 *   preview with the critic's verdict on the slot's `preview_draft` while the slot stays `planned` (no run id,
 *   no post, no verdict on the slot), and nothing is published, ledgered or put up for approval;
 * - one preview at a time per slot (a stale `running` one may be replaced);
 * - the Plan tab payload says when and by which run the plan was made, lists the superseded plans of the day,
 *   how the agent plans, and each slot's planning details (fixed / live / news-watch / skipped / written + critic).
 * Fixed 2030 dates, so nothing depends on the hour the suite runs at. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { PgRunRecorder } from '../harness/run-recorder';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { buildComposeTools } from '../tools/compose-tools';
import { buildRoleTools } from '../tools/role-tools';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorRunsRepository } from '../repo/editor-runs.repository';
import { makeDefaultCard } from '../chat/default-card';
import { CriticService } from '../critic/critic.service';
import { CRITIC_SCORE_KEYS } from '../critic/critic';
import { AgentsRepository } from '../agents/agents.repository';
import { NetworkRepository } from '../network/network.repository';
import { NetworkService } from '../network/network.service';
import { syncAgentsFor } from '../approval/pg-test-agents';
import { EditorOpsService } from '../api/editor-ops.service';
import { EditorRunnerService } from './editor-runner.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@preview_e2e_pg';
const DAY = '2030-05-06';
const MIGRATION = readFileSync(join(__dirname, '../../../../../database/migrations/070_plan_visibility.sql'), 'utf8');
// Kyiv is UTC+3 on 2030-05-06.
const at = (hhmm: string) => new Date(`${DAY}T${String(Number(hhmm.slice(0, 2)) - 3).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);
const NOW = at('09:00');
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await new EditorChannelsRepository(pool).insertIfMissing({
    ...makeDefaultCard(CH, 'Космос'), mode: 'live', planHour: 6, quietStartHour: 23, quietEndHour: 7, minGapMinutes: 30,
    postsPerDayMin: 1, postsPerDayMax: 6, formats: { text: 1 }, brief: 'Новини астрономії', hashtags: ['космос'],
    sources: [{ id: 'feed1', kind: 'rss', ref: 'https://space.example/rss' }],
  });
  await syncAgentsFor(pool, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const spec = {
  format: 'text', title: 'Вебб показав туманність Кільце', origin: 'external',
  body: [
    { type: 'lead', text: 'Телескоп Вебб показав туманність Кільце в інфрачервоному світлі.' },
    { type: 'p', text: 'На знімку видно оболонки газу, які зоря скинула тисячі років тому.' },
  ],
  hashtags: ['космос'],
  source: { url: 'https://space.example/ring', label: 'NASA' },
};
const pass = { calls: [{ name: 'submit_critique', args: { scores: Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, 5])), verdict: 'pass', notes: 'Чисто і по суті.' } }] };

test('migration 070 is idempotent: editor_slots.preview_draft exists after a second apply and the version is recorded', { skip }, async () => {
  await pool.query(MIGRATION);
  const { rows } = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'editor_slots' AND column_name = 'preview_draft'`);
  assert.deepEqual(rows.map((r) => r.data_type), ['jsonb']);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '070_plan_visibility'`)).rows[0].n, 1);
});

test('a dry-run preview and a readable plan: planned at / by, history, live / fixed / skipped / written slots', { skip }, async () => {
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool, () => NOW);
  const recorder = new PgRunRecorder(pool);
  const card = (await channels.get(CH))!;

  // Two planner runs: the 06:00 plan, then a replan at 08:30 that supersedes it.
  const runA = await recorder.start({ role: 'planner', channelKey: CH, model: 'm' });
  await recorder.finish(runA, 'ok', { steps: 2, promptTokens: 10, completionTokens: 5, costUsd: 0.002 });
  await plans.createPlan(CH, DAY, 'Ранковий план', runA, [
    { scheduledAt: at('12:00'), format: 'text', topic: 'Старий пост, який замінить переплан', angle: null, sourceHints: [], isExperiment: false },
  ]);
  const runB = await recorder.start({ role: 'planner', channelKey: CH, model: 'm' });
  await recorder.finish(runB, 'ok', { steps: 2, promptTokens: 10, completionTokens: 5, costUsd: 0.002 });
  const live = { sources: ['feed1'], brief: 'Найсвіжіша новина астрономії', max_age_hours: 6, origin: 'planner' as const };
  const planId = await plans.createPlan(CH, DAY, 'Переплан: туманність удень, новина ввечері', runB, [
    { scheduledAt: at('15:00'), format: 'text', topic: 'Туманність Кільце очима Вебба', angle: 'що видно на знімку', sourceHints: ['nasa.gov'], isExperiment: false },
    { scheduledAt: at('18:00'), format: 'text', topic: 'Свіжа новина з feed1', angle: null, sourceHints: [], isExperiment: false, live },
  ]);
  const [fixed, live18] = await plans.listSlots(CH, planId);
  // A news-watch slot, a live slot skipped for nothing fresh, and a written post with the critic's verdict.
  const ins = async (hhmm: string, extra: string, vals: unknown[]) => (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic${extra}) VALUES ($1, $2, $3, 'text', $4${vals.slice(1).map((_, i) => `, $${i + 5}`).join('')}) RETURNING id`,
    [planId, CH, at(hhmm), ...vals])).rows[0].id as string;
  const watchId = await ins('16:15', ', topic_mode, live_spec', ['Свіжа новина: Комета наблизилась до Землі', 'live',
    JSON.stringify({ sources: ['feed1'], brief: 'Свіжа новина', max_age_hours: 3, origin: 'news_watch', item: { url: 'https://space.example/comet', title: 'Комета наблизилась до Землі' } })]);
  const skippedId = await ins('08:00', ', topic_mode, live_spec, status, error', ['Свіжа новина з feed1', 'live', JSON.stringify(live), 'skipped', 'no_fresh_item: no item ≤ 6 h in feed1 (3 items: 3 old)']);
  const writtenId = await ins('08:30', ', status, rendered_preview, critic', ['Ранковий дайджест', 'published', '<b>Ранковий дайджест</b>',
    JSON.stringify({ verdict: 'pass', scores: Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, 4])), notes: 'Добре.', reason: 'scores_ok', pass: 1, slop_warnings: [], model: 'm', run_id: null, cost_usd: 0.001, at: NOW.toISOString() })]);

  // ── the preview ─────────────────────────────────────────────────────────────
  const skills = new SkillLibrary();
  const memory = new EditorMemoryRepository(pool);
  const sent: unknown[] = [];
  const registry = new ToolRegistry([
    ...buildComposeTools(),
    ...buildRoleTools({ pool, plans, memory, channels, publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [1] }; } }, recordPublish: () => {}, now: () => NOW }),
  ]);
  const execLlm = new FakeLlm([{ calls: [{ name: 'publish_post', args: { spec } }], cost: 0.004 }]);
  const critic = new CriticService({
    loop: new AgentLoop({ llm: new FakeLlm([{ ...pass, cost: 0.002 }]), recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true }),
    env: () => undefined, now: () => NOW,
  });
  const runner = new EditorRunnerService({
    loop: new AgentLoop({ llm: execLlm, recorder, budget: new FakeBudget(), enabled: () => true }),
    registry, skills, plans, memory, env: () => undefined, notify: async () => {}, now: () => NOW,
    critic: { service: critic, inbox: async () => { throw new Error('no Inbox item for a preview'); } },
  });
  const runs = new EditorRunsRepository(pool);
  const ops = new EditorOpsService({ channels, plans, memory, runs, runner, registry, skills, enabled: () => true, now: () => NOW });

  const res = await ops.previewSlot(fixed.id, { wait: true });
  assert.equal(res.preview.status, 'ready', JSON.stringify(res.preview));
  assert.match(res.preview.preview!, /Телескоп Вебб показав туманність Кільце/);
  assert.equal(res.preview.critic?.verdict, 'pass');
  assert.equal(res.preview.costUsd, 0.006);
  const row = (await pool.query(`SELECT status, run_id, post_spec, rendered_preview, critic, preview_draft, attempts FROM editor_slots WHERE id = $1`, [fixed.id])).rows[0];
  assert.deepEqual([row.status, row.run_id, row.post_spec, row.rendered_preview, row.critic, row.attempts], ['planned', null, null, null, null, 0]);
  assert.equal(row.preview_draft.status, 'ready');
  assert.equal(row.preview_draft.runId, res.preview.runId);
  assert.deepEqual(sent, [], 'nothing published (the card is live)');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`])).rows[0].n, 0, 'nothing ledgered');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM published_posts WHERE channel_id = $1`, [CH])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM editor_slots WHERE channel_key = $1 AND status = 'awaiting_approval'`, [CH])).rows[0].n, 0);
  const run = (await pool.query(`SELECT role, slot_id, status FROM editor_runs WHERE id = $1`, [res.preview.runId])).rows[0];
  assert.deepEqual([run.role, run.slot_id, run.status], ['executor', fixed.id, 'ok']);

  // One preview at a time per slot; a stale `running` one (crashed process) may be replaced.
  assert.ok(await plans.claimPreview(fixed.id, NOW));
  assert.equal(await plans.claimPreview(fixed.id, NOW), null);
  assert.ok(await plans.claimPreview(fixed.id, new Date(NOW.getTime() + 11 * 60_000)), 'stale after 10 min');
  await plans.setPreview(fixed.id, row.preview_draft);
  // Only planned content slots.
  assert.equal(await plans.claimPreview(writtenId, NOW), null);

  // The slot page: plan made by run B, the stored preview, the typical cost.
  const page = await ops.slotDetail(fixed.id);
  assert.deepEqual([page.plan?.runId, page.plan?.runRole, page.plan?.status], [runB, 'planner', 'active']);
  assert.equal(page.previewDraft?.status, 'ready');
  assert.equal(page.previewEstimateUsd, 0.004, 'the last finished executor run (the preview) — no critic runs recorded in PG here');

  // ── the Plan tab payload ────────────────────────────────────────────────────
  const agents = new AgentsRepository(pool);
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const svc = new NetworkService({
    pool, agents, repo: new NetworkRepository(pool), inbox: { post: async () => ({}) as any }, card: (k) => channels.get(k),
    rebuild: async () => null, now: () => NOW,
  });
  const day = await svc.plan(orch.handle, DAY);
  const created = (await pool.query(`SELECT created_at FROM editor_plans WHERE id = $1`, [planId])).rows[0].created_at as Date;
  assert.equal(day.planId, planId);
  assert.equal(new Date(day.plannedAt).getTime(), created.getTime());
  assert.deepEqual([day.runId, day.runRole], [runB, 'planner']);
  assert.deepEqual(day.schedule, { timezone: 'Europe/Kyiv', planHour: 6, mode: card.mode, approval: false, batchHour: 20 });
  assert.deepEqual(day.history.map((h) => [h.runId, h.runRole, h.rationale, h.slots]), [[runA, 'planner', 'Ранковий план', 1]]);
  assert.equal(day.previewEstimateUsd, 0.004);
  const by = new Map(day.slots.map((s) => [s.id, s]));
  const f = by.get(fixed.id)!;
  assert.deepEqual([f.topicMode, f.topic, f.angle, f.sourceHints, f.previewDraft?.status, f.critic], ['fixed', 'Туманність Кільце очима Вебба', 'що видно на знімку', ['nasa.gov'], 'ready', null]);
  assert.ok(f.createdAt);
  const l = by.get(live18.id)!;
  assert.deepEqual([l.topicMode, l.liveSpec?.sources, l.liveSpec?.max_age_hours, l.liveSpec?.origin], ['live', ['feed1'], 6, 'planner']);
  const w = by.get(watchId)!;
  assert.deepEqual([w.liveSpec?.origin, w.liveSpec?.item?.url], ['news_watch', 'https://space.example/comet']);
  assert.match(by.get(skippedId)!.error!, /^no_fresh_item:/);
  assert.equal(by.get(writtenId)!.critic?.verdict, 'pass');
  assert.equal(by.get(writtenId)!.preview, '<b>Ранковий дайджест</b>');

  // /api/editor/plans: active first, then the superseded one, each with its run's role.
  const listed = await ops.listPlans(DAY, CH);
  assert.deepEqual(listed.plans.map((p) => [p.status, p.runId, p.runRole]), [['active', runB, 'planner'], ['superseded', runA, 'planner']]);
  assert.deepEqual(listed.previewEstimates, { [CH]: 0.004 });
});
