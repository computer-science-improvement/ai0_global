/**
 * Spec 020 end to end on a throwaway Postgres with a scripted LLM:
 * brief → playbook (pending) → owner approves → network independent → ideas →
 * review → network day plan → Telegram + Instagram executors in shadow → ideas used.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm } from '../harness/testing/fakes';
import { PgRunRecorder } from '../harness/run-recorder';
import { SkillLibrary } from '../skills/skill-library';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { makeDefaultCard } from '../chat/default-card';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { buildRoleTools } from '../tools/role-tools';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { AgentRuntime } from '../agents/agent-runtime';
import { SkillStore } from '../agents/skill-store';
import { OwnerInbox } from '../agents/owner-inbox';
import { ResourceProfilesRepository } from '../agents/resource-profile';
import { PlatformPostsRepository } from '../platform/platform-posts.repository';
import { buildPlatformTools } from '../platform/platform-tools';
import { NetworkRepository } from './network.repository';
import { NetworkRunner } from './network-runner';
import { NetworkService } from './network.service';
import { buildNetworkTools } from './network-tools';
import { localDate } from '../roles/time';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@net_e2e_pg';
let pool: Pool;
let groupId: string;
let igId: string;

async function cleanup() {
  const { rows } = await pool.query(`SELECT id FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  for (const r of rows) {
    await pool.query(`DELETE FROM content_ideas WHERE agent_id = $1`, [r.id]);
    await pool.query(`DELETE FROM playbooks WHERE agent_id = $1`, [r.id]);
  }
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM platform_posts WHERE resource_ref LIKE 'instagram:%' AND caption LIKE '%Сатурн%'`);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id = 'net-e2e-ig'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name = 'Космос e2e'`);
  await pool.query(`DELETE FROM agent_inbox WHERE title LIKE '%net_e2e%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform) VALUES ('Космос e2e', 'telegram') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'net_e2e_pg', 'Космос', true, $2)`, [CH, groupId]);
  igId = (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id, last_verified_at) VALUES ('instagram', 'net-e2e-ig', 'X', 't', 'space_ig', $1, now()) RETURNING id`,
    [groupId])).rows[0].id;
  await new EditorChannelsRepository(pool).insertIfMissing({
    ...makeDefaultCard(CH, 'Космос'), mode: 'shadow', planHour: 0, quietStartHour: 23, quietEndHour: 0, postsPerDayMin: 1, postsPerDayMax: 4,
    formats: { longread: 1, photo: 1, text: 1, carousel: 1 }, brief: 'TG — лонгріди, IG — каруселі',
  });
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('brief → playbook → independent network → ideas → plan → native posts in shadow', { skip }, async () => {
  const IG = `instagram:${igId}`;
  const now = new Date();
  const kyivHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(now));
  if (kyivHour >= 20) return; // the plan needs two slots ≥ 90 min apart before the day ends
  const hh = (h: number) => String(Math.min(23, kyivHour + h)).padStart(2, '0');

  const agents = new AgentsRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  await new AgentRegistrySync({ agents, channels }).run();
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const repo = new NetworkRepository(pool);
  const inbox = new OwnerInbox(pool);
  const profiles = new ResourceProfilesRepository(pool);
  const posts = new PlatformPostsRepository(pool);
  const files = new SkillLibrary();
  const runtime = new AgentRuntime({ agents, store: new SkillStore(pool), fallback: files });

  const playbook = {
    platforms: [
      { resource_ref: `telegram:${CH}`, role: 'core', formats: { longread: 1 }, per_day: { min: 0, max: 3 }, best_hours: [10] },
      { resource_ref: IG, role: `funnel_to:telegram:${CH}`, formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, hashtag_policy: { vocab: ['космос'], min: 1, max: 5 } },
    ],
  };
  const IDEA_TITLE = 'Кільця Сатурна зникають';
  const llm = new FakeLlm([
    // playbook build
    { calls: [{ name: 'submit_playbook', args: { body: playbook, rationale: 'Бриф: TG — лонгріди, IG — каруселі, що ведуть у TG.' } }] },
    // idea reviewer: playbook review
    { calls: [{ name: 'review_playbook', args: { verdict: 'ok', comments: ['Відповідає брифу'] } }] },
    { calls: [{ name: 'finish_idea_review', args: { summary: 'Плейбук ок' } }] },
    // daily orchestration
    { calls: [{ name: 'add_idea', args: {
      title: IDEA_TITLE, angle: 'Чому кільця тоншають і коли їх не стане', sources: ['https://nasa.gov/saturn-rings'], why: 'Пости про Сатурн дають ×1,5 переглядів',
      variants: [{ resource_ref: `telegram:${CH}`, format: 'longread' }, { resource_ref: IG, format: 'ig_carousel', note: '6 слайдів' }],
    } }] },
    { calls: [{ name: 'finish_orchestration', args: { summary: 'Додав 1 ідею' } }] },
    // idea review
    { calls: [{ name: 'list_ideas', args: { status: ['new'] } }] },
    { text: null, calls: [{ name: 'review_idea', args: { id: '__IDEA__', verdict: 'accept', scores: { fit: 5, novelty: 4, verifiability: 5, platform_fit: 4, risk: 5 }, comment: 'Джерело NASA, нова тема' } }] },
    { calls: [{ name: 'finish_idea_review', args: { summary: '1 прийнято' } }] },
    // network planner
    { calls: [{ name: 'submit_network_plan', args: { rationale: 'Сатурн: спершу TG, потім IG', slots: [
      { resource_ref: `telegram:${CH}`, time: `${hh(1)}:00`, format: 'longread', topic: IDEA_TITLE, idea_id: '__IDEA__' },
      { resource_ref: IG, time: `${hh(3)}:00`, format: 'ig_carousel', topic: `${IDEA_TITLE} — карусель`, idea_id: '__IDEA__' },
    ] } }] },
    // IG executor (shadow)
    { calls: [{ name: 'publish_platform_post', args: { spec: {
      format: 'ig_carousel', title: IDEA_TITLE, caption: 'Кільця Сатурна тоншають — і ось чому. Гортай 👉 Посилання в біо.', hashtags: ['космос', 'сатурн'],
      slides: [{ title: 'Сатурн', text: 'Кільця втрачають масу.' }, { title: 'Коли?', text: 'За ~300 млн років.' }], idea_id: '__IDEA__',
    } } }] },
  ]);
  // The idea id is known only after add_idea: patch the script lazily.
  const origChat = llm.chat.bind(llm);
  (llm as any).chat = async (req: any) => {
    const res = await origChat(req);
    const ideas = await repo.listIdeas(orch.id, null, 5);
    const id = ideas[0]?.id;
    if (id && res.message.toolCalls) for (const c of res.message.toolCalls) c.arguments = c.arguments.replaceAll('__IDEA__', id);
    return res;
  };
  const recorder = new PgRunRecorder(pool);
  const loop = new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true });
  const registry = new ToolRegistry([
    ...buildNetworkTools({ repo, plans, memory, inbox }),
    ...buildPlatformTools({
      pool, plans,
      publish: { posts, publisher: { publish: async () => { throw new Error('no live publishing in tests'); } }, health: async () => null },
    }),
    ...buildRoleTools({
      pool, plans, memory, channels, publisher: { send: async () => { throw new Error('no live publishing in tests'); } }, recordPublish: () => {},
    }),
  ]);
  const env = () => undefined;
  const network = new NetworkRunner({ loop, registry, runtime, memory, repo, plans, profiles, env, notify: async () => {} });
  const svc = new NetworkService({
    pool, agents, repo, inbox, card: (k) => channels.get(k), rebuild: (c, b) => network.runPlaybookBuild(c, b),
  });
  const card = (await channels.get(CH))!;

  // 1. Playbook from the brief → pending owner, reviewed.
  await network.runPlaybookBuild(card, card.brief);
  const pb = await svc.playbook(orch.handle);
  assert.equal(pb.pending?.status, 'pending_owner');
  assert.deepEqual((pb.pending?.review as any)?.comments, ['Відповідає брифу']);
  // Spec 024: no playbook guard any more — legacy_duplicate first, then independent.
  assert.deepEqual(await svc.setMode(orch.handle, { mode: 'legacy_duplicate' }), { mode: 'legacy_duplicate', group: 'Космос e2e' });

  // 2. Owner approves; the network becomes independent ('orchestrated' is a deprecated alias).
  await svc.decide(pb.pending!.id, true);
  const res = await svc.setMode(orch.handle, { mode: 'orchestrated' });
  assert.equal(res.mode, 'independent');
  assert.equal((res as any).deprecated_alias, 'orchestrated');
  assert.equal((await repo.groupOfChannel(CH))!.mode, 'independent');

  // 3. Daily orchestration + idea review.
  await network.runOrchestrator(card);
  const accepted = await repo.listIdeas(orch.id, ['accepted'], 10);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].title, IDEA_TITLE);

  // 4. The planner of an independent network plans both resources.
  const runner = new EditorRunnerService({
    loop, registry, skills: files, runtime, plans, memory, env, notify: async () => {}, network,
    platformContext: (slot, o) => network.platformContext(slot, o),
    onSlotDone: async (slot) => { if (slot.ideaId) await repo.settleIdea(slot.ideaId); },
  });
  const plan = await runner.runPlanner(card);
  assert.equal(plan.terminalTool, 'submit_network_plan', plan.error);
  const day = await svc.plan(orch.handle, localDate(now, 'Europe/Kyiv'));
  assert.deepEqual(day.slots.map((s) => s.resourceRef), [`telegram:${CH}`, IG]);
  assert.equal((await repo.idea(accepted[0].id))!.status, 'planned');

  // 5. The Instagram slot runs the platform executor in shadow.
  const igSlot = (await plans.getSlot(day.slots[1].id))!;
  await pool.query(`UPDATE editor_slots SET status = 'running' WHERE id = $1`, [igSlot.id]);
  const ex = await runner.runExecutor({ ...igSlot, status: 'running' }, card);
  assert.equal(ex.terminalTool, 'publish_platform_post', ex.error);
  assert.equal((await plans.getSlot(igSlot.id))!.status, 'shadowed');
  const shadowed = await posts.recent(IG, 1);
  assert.equal(shadowed[0].status, 'shadowed');
  assert.match(shadowed[0].caption!, /#космос #сатурн/);
  // The Telegram variant is still planned → the idea is not used yet.
  assert.equal((await repo.idea(accepted[0].id))!.status, 'planned');
  await pool.query(`UPDATE editor_slots SET status = 'shadowed' WHERE id = $1`, [day.slots[0].id]);
  await repo.settleIdea(accepted[0].id);
  assert.equal((await repo.idea(accepted[0].id))!.status, 'used');

  // Review fix: an idea left `planned` without slots (replanned / stale) goes back to the pool.
  const orphan = await repo.addIdea({ agentId: orch.id, title: 'Сироту повертаємо в пул', sources: ['https://x'], variants: [], origin: 'owner', expiresAt: new Date(Date.now() + 86_400_000), status: 'planned' });
  assert.equal(await repo.releaseStalePlanned(orch.id), 1);
  assert.equal((await repo.idea(orphan.id))!.status, 'accepted');
});
