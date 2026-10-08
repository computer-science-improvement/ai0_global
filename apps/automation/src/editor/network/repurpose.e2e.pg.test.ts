/**
 * Spec 024 T4 on a throwaway Postgres: repurpose_post end to end — the
 * executor schedules an "after this is published" duplicate of its own slot,
 * a re-plan keeps repurposed slots, a strategy carousel is a valid source
 * (slides gone → source_media_gone; a text target is formatted by the agent),
 * already_decided, the daily call limit, and the chat Apply / Decline card.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
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
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { AgentRuntime } from '../agents/agent-runtime';
import { SkillStore } from '../agents/skill-store';
import { PendingActionsRepository, PendingActionsService } from '../agents/pending-actions';
import { ResourceProfileSchema, ResourceProfilesRepository } from '../agents/resource-profile';
import { ResourceTime } from '../time/resource-time';
import { PlatformPostsRepository } from '../platform/platform-posts.repository';
import { buildPlatformTools } from '../platform/platform-tools';
import { localDate } from '../roles/time';
import { NetworkRepository } from './network.repository';
import { networkContext } from './network-context';
import { DerivedSlots } from './derived-slots';
import { buildRepurposeTools, REPURPOSE_CALLS_PER_DAY, RepurposeInput, RepurposeService } from './repurpose-tool';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@rep024_pg';
const GROUP = 'rep024 e2e';
let pool: Pool;

async function cleanup() {
  const { rows } = await pool.query(`SELECT id FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  for (const r of rows) {
    await pool.query(`DELETE FROM content_decisions WHERE agent_id = $1`, [r.id]);
    await pool.query(`DELETE FROM pending_actions WHERE agent_id = $1`, [r.id]);
    await pool.query(`DELETE FROM playbooks WHERE agent_id = $1`, [r.id]);
  }
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  const { rows: ma } = await pool.query(`SELECT id, platform FROM meta_accounts WHERE account_id LIKE 'rep024-%'`);
  for (const m of ma) {
    await pool.query(`DELETE FROM platform_posts WHERE resource_ref = $1`, [`${m.platform}:${m.id}`]);
    await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [`${m.platform}:${m.id}`]);
  }
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id LIKE 'rep024-%'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name = $1`, [GROUP]);
}

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

test('repurpose_post: own slot, re-plan, strategy source, already_decided, daily limit, chat Apply / Decline', { skip }, async () => {
  const groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', 'independent') RETURNING id`, [GROUP])).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'rep024_pg', 'Кухня', true, $2)`, [CH, groupId]);
  const acc = async (platform: string) => (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id, last_verified_at) VALUES ($1, $2, 'X', 't', $2, $3, now()) RETURNING id`,
    [platform, `rep024-${platform}`, groupId])).rows[0].id;
  const IG = `instagram:${await acc('instagram')}`;
  const TH = `threads:${await acc('threads')}`;
  const channels = new EditorChannelsRepository(pool);
  // No quiet hours anywhere: the test must not depend on the hour it runs at.
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'Кухня'), mode: 'shadow', planHour: 0, quietStartHour: 0, quietEndHour: 0, formats: { photo: 1, text: 1 } });
  const profiles = new ResourceProfilesRepository(pool);
  for (const ref of [IG, TH]) {
    await profiles.setProfile(ref, ResourceProfileSchema.parse({ topic: 'Рецепти', audience: { who: 'домашні кухарі' }, goals: ['growth'], quiet_hours: { start: 0, end: 0 } }), 'owner');
  }
  const agents = new AgentsRepository(pool);
  await new AgentRegistrySync({ agents, channels }).run();
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const repo = new NetworkRepository(pool);
  await repo.insertPlaybook({
    agentId: orch.id, status: 'active', brief: null, createdBy: 'owner', rationale: 'e2e',
    body: { platforms: [
      { resource_ref: `telegram:${CH}`, role: 'core', formats: { photo: 1 }, per_day: { min: 0, max: 5 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
      { resource_ref: IG, role: 'discovery', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 5 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
      { resource_ref: TH, role: 'discovery', formats: { th_text: 1 }, per_day: { min: 0, max: 5 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
    ], series: [], pillars: [], rules: [] } as any,
  });
  const card = (await channels.get(CH))!;
  const time = new ResourceTime({ card: (k) => channels.get(k), profile: (ref) => profiles.rawProfile(ref), warn: async () => {} });
  const netOf = async () => (await networkContext({ repo, time }, orch, card))!;
  const plans = new EditorPlansRepository(pool);
  const service = new RepurposeService({ pool, plans });
  const actionsRepo = new PendingActionsRepository(pool);
  const actions = new PendingActionsService(actionsRepo);
  const [tool] = buildRepurposeTools({ service, networkFor: async () => netOf(), actions });
  const now = new Date();
  const today = localDate(now, card.timezone);
  // The scenario spans now … now + 3 h inside one local day; late in the evening it would cross midnight.
  const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: card.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  if (localHour >= 20) return;

  // A. The executor duplicates its own slot: the derived post waits until the source is out.
  const at = new Date(now.getTime() + 30 * 60_000);
  const planId = await plans.createNetworkPlan(CH, today, 'День кухні', null, [
    { resourceRef: `telegram:${CH}`, scheduledAt: at, format: 'photo', topic: 'Деруни з грибами', angle: null, ideaId: null, sourceHints: [], treatment: 'unique' },
  ]);
  const [src] = await plans.listSlots(CH, planId);
  const r1: any = await tool.execute(RepurposeInput.parse({ source: { slot_id: src.id }, targets: [{ resource_ref: TH, treatment: 'adapt', delay_min: 15, reason: 'Threads любить короткі рецепти' }] }),
    { runId: '00000000-0000-4000-8000-0000000000aa', role: 'executor', channelKey: CH, slotId: src.id, extras: { card, orchestrator: orch } });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const derived = (await plans.getSlot(r1.slots[0].id))!;
  assert.deepEqual([derived.treatment, derived.derivedFromSlotId, derived.sourcePost?.via, derived.resourceRef], ['adapt', src.id, 'repurpose', TH]);
  assert.equal(derived.scheduledAt.getTime(), at.getTime() + 15 * 60_000);
  const d1 = (await pool.query(`SELECT decided_by, call_id, source_key FROM content_decisions WHERE slot_id = $1`, [derived.id])).rows[0];
  assert.deepEqual([d1.decided_by, d1.source_key], ['executor', `slot:${src.id}`]);
  assert.ok(d1.call_id);
  const claimed = (await plans.claimDue(new Date(at.getTime() + 60 * 60_000), 20)).filter((s) => s.channelKey === CH).map((s) => s.id);
  assert.deepEqual(claimed, [src.id], 'the duplicate waits for its source');

  // B. A re-plan of the day keeps the repurposed slot.
  const replan = await plans.createNetworkPlan(CH, today, 'Новий план дня', null, [
    { resourceRef: `telegram:${CH}`, scheduledAt: new Date(now.getTime() + 3 * 3600_000), format: 'photo', topic: 'Сирники', angle: null, ideaId: null, sourceHints: [], treatment: 'unique' },
  ]);
  const moved = (await plans.getSlot(derived.id))!;
  assert.equal(moved.planId, replan);
  assert.equal(moved.status, 'planned');

  // C. A strategy carousel is a valid source; its slides are gone → source_media_gone; a text target is formatted by the agent.
  const tg = (await pool.query(
    `INSERT INTO published_posts (channel_id, message_id, source_url, title, strategy_type, tags, format) VALUES ($1, 501, 'https://recipes.example/borshch', 'Борщ за 40 хвилин', 'recipe-carousel', '{борщ}', 'carousel') RETURNING id`,
    [CH])).rows[0].id;
  const r2: any = await tool.execute(RepurposeInput.parse({ source: { published_post_id: Number(tg) }, targets: [
    { resource_ref: IG, treatment: 'duplicate', delay_min: 0, reason: 'Карусель рецепта для IG-аудиторії' },
    { resource_ref: TH, treatment: 'duplicate', delay_min: 0, format: 'th_text', reason: 'Короткий рецепт для Threads' },
  ] }), { runId: '00000000-0000-4000-8000-0000000000bb', role: 'orchestrator', channelKey: CH, extras: { card, orchestrator: orch, network: await netOf() } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const [igSlot, thSlot] = await Promise.all(r2.slots.map((s: any) => plans.getSlot(s.id)));
  assert.equal(igSlot!.format, 'ig_carousel');
  assert.equal(igSlot!.derivedFromSlotId, undefined);
  assert.equal(igSlot!.sourcePost?.key, `tg:${tg}`);

  const llm = new FakeLlm([{ calls: [{ name: 'publish_platform_post', args: { spec: { format: 'th_text', title: 'Борщ за 40 хвилин', caption: 'Борщ за 40 хвилин: буряк, капуста, квасоля — і жодного секрету. Рецепт у профілі.', hashtags: ['борщ'] } } }] }]);
  const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), budget: new FakeBudget(), enabled: () => true });
  const posts = new PlatformPostsRepository(pool);
  const registry = new ToolRegistry(buildPlatformTools({ pool, plans, publish: { posts, publisher: { publish: async () => { throw new Error('no live publishing in tests'); } }, health: async () => null } }));
  const files = new SkillLibrary();
  const memory = new EditorMemoryRepository(pool);
  const runtime = new AgentRuntime({ agents, store: new SkillStore(pool), fallback: files });
  const runner = new EditorRunnerService({
    loop, registry, skills: files, runtime, plans, memory, env: () => undefined, notify: async () => {},
    derived: { resolve: (s) => new DerivedSlots({ pool }).resolve(s) },
  });
  await pool.query(`UPDATE editor_slots SET status = 'running' WHERE id = ANY($1::uuid[])`, [[igSlot!.id, thSlot!.id]]);
  const ri = await runner.runExecutor({ ...igSlot!, status: 'running' }, card);
  assert.equal(ri.error, 'source_media_gone');
  assert.equal((await plans.getSlot(igSlot!.id))!.status, 'skipped');
  const rt = await runner.runExecutor({ ...thSlot!, status: 'running' }, card);
  assert.equal(rt.terminalTool, 'publish_platform_post', rt.error);
  assert.equal((await plans.getSlot(thSlot!.id))!.status, 'shadowed');
  assert.match(String(llm.requests[0].messages[1].content), /Борщ за 40 хвилин/);

  // D. One decision per (source, resource).
  const again: any = await tool.execute(RepurposeInput.parse({ source: { published_post_id: Number(tg) }, targets: [{ resource_ref: TH, treatment: 'adapt', reason: 'Ще раз на Threads, інакше' }] }),
    { runId: 'x', role: 'orchestrator', channelKey: CH, extras: { card, orchestrator: orch, network: await netOf() } });
  assert.equal(again.error, 'already_decided');

  // E. The orchestrator's daily call limit (calls, not targets).
  const used = Number((await pool.query(`SELECT COUNT(DISTINCT call_id)::int AS n FROM content_decisions WHERE agent_id = $1 AND call_id IS NOT NULL`, [orch.id])).rows[0].n);
  for (let k = used; k < REPURPOSE_CALLS_PER_DAY; k++) {
    await pool.query(`INSERT INTO content_decisions (agent_id, source_key, resource_ref, decision, reason, decided_by, call_id) VALUES ($1, $2, $3, 'duplicate', 'filler for the cap', 'orchestrator', gen_random_uuid())`,
      [orch.id, `tg:filler-${k}`, TH]);
  }
  const tg2 = (await pool.query(`INSERT INTO published_posts (channel_id, message_id, title, format) VALUES ($1, 502, 'Сирники', 'photo') RETURNING id`, [CH])).rows[0].id;
  const capped: any = await tool.execute(RepurposeInput.parse({ source: { published_post_id: Number(tg2) }, targets: [{ resource_ref: TH, treatment: 'adapt', reason: 'Короткий рецепт для Threads' }] }),
    { runId: 'x', role: 'orchestrator', channelKey: CH, extras: { card, orchestrator: orch, network: await netOf() } });
  assert.equal(capped.error, 'daily_limit');

  // F. Chat: Decline creates nothing; Apply creates the slots as the owner's decision (outside the agent's cap).
  actions.register('repurpose', async (p) => {
    const { handle: _h, ...rest } = p as Record<string, unknown>;
    const r: any = await service.run(await netOf(), card, RepurposeInput.parse(rest), { decidedBy: 'owner' });
    if ('error' in r) throw new Error(r.error);
    return r;
  });
  const payload = { handle: orch.handle, source: { published_post_id: Number(tg2) }, targets: [{ resource_ref: TH, treatment: 'adapt', reason: 'Власник хоче цей рецепт у Threads' }] };
  const declined = await actions.propose({ chatId: null, agentId: orch.id, kind: 'repurpose', payload, summary: 'Repurpose' });
  await actions.discard(declined.id);
  const none = await pool.query(`SELECT 1 FROM content_decisions WHERE source_key = $1`, [`tg:${tg2}`]);
  assert.equal(none.rowCount, 0);
  const applied = await actions.apply((await actions.propose({ chatId: null, agentId: orch.id, kind: 'repurpose', payload, summary: 'Repurpose' })).id);
  assert.equal(applied.status, 'applied', applied.error ?? '');
  const own = (await pool.query(`SELECT decided_by, slot_id FROM content_decisions WHERE source_key = $1`, [`tg:${tg2}`])).rows;
  assert.deepEqual(own.map((r) => r.decided_by), ['owner']);
  assert.ok(await plans.getSlot(own[0].slot_id));
});
