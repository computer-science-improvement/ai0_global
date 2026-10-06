/**
 * Spec 031 T5 against a real throwaway Postgres, a scripted LLM and a fake
 * Telegram sender: the owner's approve → live switch (with "approve the waiting
 * posts too"), the next slot publishing without a card, live → approve making
 * the next slot wait, and a promo cross-promo of an approval channel getting a
 * working tracked link. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { PgRunRecorder } from '../harness/run-recorder';
import { BudgetService } from '../harness/budget.service';
import { FakeLlm } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { buildComposeTools } from '../tools/compose-tools';
import { buildRoleTools } from '../tools/role-tools';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRuntime } from '../agents/agent-runtime';
import { resourceRef } from '../agents/agent.types';
import { effectiveMode, type EditorCard } from '../card';
import type { TgMessage } from '../post/render-telegram';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalsService } from './approvals.service';
import { ApprovalStatsRepository } from './approval-stats';
import { AutonomyService } from './autonomy';
import { syncAgentsFor } from './pg-test-agents';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@t5_autonomy_pg';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(
    `INSERT INTO editor_channels (channel_key, mode, title, brief, formats, hashtags, posts_per_day_min, posts_per_day_max, plan_hour, min_gap_minutes)
     VALUES ($1, 'approve', 'Космос щодня', 'Короткі пояснення космічних знімків', '{"photo":1,"text":0.5}', '{космос,nasa}', 1, 5, 0, 60)`, [CH]);
  await syncAgentsFor(pool, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const spec = (n: string, lead: string, text: string) => ({
  format: 'text', title: `Пост ${n}`, origin: 'external',
  body: [{ type: 'lead', text: lead }, { type: 'p', text }],
  hashtags: ['космос'],
  source: { url: `https://www.nasa.gov/t5-${n}`, label: 'NASA' },
});
const SPEC_1 = spec('1', 'Webb знайшов воду в атмосфері далекої планети', 'Спектр показав пару води над хмарами газового гіганта WASP-96b. Це перший такий чіткий спектр від Webb.');
const SPEC_2 = spec('2', 'Марсохід Perseverance зібрав двадцятий зразок ґрунту', 'Капсулу з породою з дельти кратера Єзеро залишили на поверхні, щоб пізніше забрати її на Землю.');

/** The module's wiring of the switch, the effective mode and the executor, with a fake Telegram sender. */
function harness(turns: ConstructorParameters<typeof FakeLlm>[0], clock: { now: Date }) {
  const now = () => clock.now;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const agents = new AgentsRepository(pool);
  const repo = new ApprovalsRepository(pool);
  const skills = new SkillLibrary();
  const runtime = new AgentRuntime({ agents, store: null, fallback: skills, now });
  const sent: TgMessage[][] = [];
  const publisher = { send: async (_k: string, messages: TgMessage[]) => { sent.push(messages); return { messageIds: messages.map((_, i) => 7000 + sent.length * 10 + i) }; } };
  const registry = new ToolRegistry([...buildComposeTools(), ...buildRoleTools({ pool, plans, memory, channels, publisher, recordPublish: () => {}, now })]);
  const loop = new AgentLoop({
    llm: new FakeLlm(turns), recorder: new PgRunRecorder(pool), enabled: () => true,
    budget: new BudgetService(pool, { globalDailyUsd: 100, channelDailyUsd: 100 }),
  });
  const runner = new EditorRunnerService({ loop, registry, skills, runtime, plans, memory, env: () => undefined, notify: async () => {}, now });
  const mode = async (c: EditorCard) => effectiveMode((await runtime.forChannel(c.channelKey, 'executor')).orchestrator?.mode ?? null, c.mode);
  const approvals = new ApprovalsService({ repo, card: (k) => channels.get(k), now });
  const autonomy = new AutonomyService({
    stats: new ApprovalStatsRepository(pool), card: (k) => channels.get(k), mode,
    setMode: async (key, m) => {
      const card = (await channels.get(key))!;
      await channels.upsert({ ...card, mode: m });
      const orch = await agents.findTop('orchestrator', 'resource', resourceRef('telegram', key));
      if (orch && orch.mode !== m) await agents.update(orch.id, { mode: m, shadowUntil: null });
    },
    waiting: (key) => repo.list({ status: ['awaiting_approval'], channel: key }),
    approve: (id) => approvals.approve(id),
    now,
  });
  return { channels, plans, runner, autonomy, mode, sent };
}

async function slot(planId: string, at: Date, o: { status?: string; warnings?: string[]; topic?: string } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec, rendered_preview, render_messages, lint_warnings)
     VALUES ($1, $2, $3, 'text', $4, $5, $6, 'превʼю', $7, $8) RETURNING id`,
    [planId, CH, at, o.topic ?? 'Пост', o.status ?? 'awaiting_approval', JSON.stringify(spec(`seed-${Math.random()}`, 'Старий пост', 'Текст старого поста.')),
      JSON.stringify({ kind: 'telegram', messages: [{ method: 'sendMessage', text: 'x', preview: null, buttons: [] }], primary: 0 }),
      JSON.stringify(o.warnings ?? [])]);
  return rows[0].id;
}

test('approve → live: the dialog numbers, waiting posts approved (warnings left), the next slot publishes without a card; live → approve: the next slot waits', { skip }, async () => {
  const clock = { now: new Date('2030-05-07T09:00:00Z') }; // Tue 12:00 Kyiv
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, '2030-05-07', 'день') RETURNING id`, [CH])).rows[0].id;
  const clean = await slot(plan, new Date('2030-05-07T15:00:00Z'), { topic: 'Чистий' });
  const warned = await slot(plan, new Date('2030-05-07T16:00:00Z'), { topic: 'З попередженням', warnings: ['підпис довгий'] });

  const h1 = harness([
    { calls: [{ name: 'lint_post', args: { spec: SPEC_1 } }] },
    { calls: [{ name: 'publish_post', args: { spec: SPEC_1 } }] },
  ], clock);
  const card0 = (await h1.channels.get(CH))!;
  assert.equal(await h1.mode(card0), 'approve');

  const preview = await h1.autonomy.preview({ channel: CH });
  assert.deepEqual([preview.mode, preview.waiting, preview.waitingWithWarnings, preview.days], ['approve', 2, 1, 14]);

  const r = await h1.autonomy.switchMode({ channel: CH, mode: 'live' });
  assert.deepEqual([r.from, r.to, r.approved, r.skippedWithWarnings, r.leftWaiting], ['approve', 'live', 1, 1, 1]);
  const st = async (id: string) => (await pool.query(`SELECT status, approved_at FROM editor_slots WHERE id = $1`, [id])).rows[0];
  assert.equal((await st(clean)).status, 'approved');
  assert.ok((await st(clean)).approved_at);
  assert.equal((await st(warned)).status, 'awaiting_approval', 'a post with warnings waits for a manual look');
  const card1 = (await h1.channels.get(CH))!;
  assert.equal(card1.mode, 'live');
  assert.equal((await new AgentsRepository(pool).findTop('orchestrator', 'resource', `telegram:${CH}`))!.mode, 'live');
  assert.equal(await h1.mode(card1), 'live');
  const audit = await pool.query(`SELECT text FROM editor_channel_memory WHERE channel_key = $1 AND created_by = 'owner' AND NOT active`, [CH]);
  assert.ok(audit.rows.some((x) => /approve→live by owner/.test(x.text)), 'the switch is audited');

  // The next slot: written and published at its time, no card.
  const next = await slot(plan, clock.now, { status: 'planned', topic: 'Вода на WASP-96b' });
  await pool.query(`UPDATE editor_slots SET post_spec = NULL, render_messages = NULL, rendered_preview = NULL WHERE id = $1`, [next]);
  const claimed = (await h1.plans.claimSlot(next))!;
  const res = await h1.runner.runExecutor(claimed, card1);
  assert.equal(res.terminalTool, 'publish_post', JSON.stringify(res));
  const after = (await h1.plans.getSlot(next))!;
  assert.equal(after.status, 'published', `${after.status} ${after.error ?? ''}`);
  assert.equal(after.approvedAt, undefined, 'live: no approval involved');
  assert.equal(h1.sent.length, 1);

  // live → approve in one call: the next slot waits.
  clock.now = new Date('2030-05-07T12:00:00Z');
  const h2 = harness([
    { calls: [{ name: 'lint_post', args: { spec: SPEC_2 } }] },
    { calls: [{ name: 'publish_post', args: { spec: SPEC_2 } }] },
  ], clock);
  const back = await h2.autonomy.switchMode({ channel: CH, mode: 'approve' });
  assert.deepEqual([back.from, back.to, back.changed], ['live', 'approve', true]);
  const card2 = (await h2.channels.get(CH))!;
  assert.equal(await h2.mode(card2), 'approve');
  const third = await slot(plan, clock.now, { status: 'planned', topic: 'Perseverance' });
  await pool.query(`UPDATE editor_slots SET post_spec = NULL, render_messages = NULL, rendered_preview = NULL WHERE id = $1`, [third]);
  const res2 = await h2.runner.runExecutor((await h2.plans.claimSlot(third))!, card2);
  assert.equal(res2.terminalTool, 'publish_post', JSON.stringify(res2));
  assert.equal((await h2.plans.getSlot(third))!.status, 'awaiting_approval');
  assert.equal(h2.sent.length, 0, 'nothing sent in approval mode');
});
