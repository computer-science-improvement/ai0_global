/**
 * Spec 024 T3 on a throwaway Postgres with a scripted LLM: the planner records
 * per-resource decisions; a duplicate waits for its source and is formatted by
 * ONE short executor run (format notes + format_prefs in its prompt); a failed
 * source skips its derived slot; a shadowed source keeps the duplicate shadow
 * even in live; stale derived slots name source_not_published; held slides
 * are released after the last derived slot or after 24 h.
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
import { buildRoleTools } from '../tools/role-tools';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { AgentRuntime } from '../agents/agent-runtime';
import { SkillStore } from '../agents/skill-store';
import { OwnerInbox } from '../agents/owner-inbox';
import { ResourceProfileSchema, ResourceProfilesRepository } from '../agents/resource-profile';
import { ResourceTime } from '../time/resource-time';
import { PlatformPostsRepository } from '../platform/platform-posts.repository';
import { buildPlatformTools } from '../platform/platform-tools';
import { MediaHolds } from '../publish/media-holds';
import { makeSpec } from '../post/testing/fixtures';
import { localDate, zonedToUtc } from '../roles/time';
import { NetworkRepository } from './network.repository';
import { NetworkRunner } from './network-runner';
import { buildNetworkTools } from './network-tools';
import { DerivedSlots } from './derived-slots';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@der024_pg';
const GROUP = 'der024 e2e';
let pool: Pool;

async function cleanup() {
  const { rows } = await pool.query(`SELECT id FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  for (const r of rows) {
    await pool.query(`DELETE FROM content_decisions WHERE agent_id = $1`, [r.id]);
    await pool.query(`DELETE FROM content_ideas WHERE agent_id = $1`, [r.id]);
    await pool.query(`DELETE FROM playbooks WHERE agent_id = $1`, [r.id]);
  }
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE scope_id = $1)`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  const { rows: ma } = await pool.query(`SELECT id FROM meta_accounts WHERE account_id = 'der024-ig'`);
  for (const m of ma) {
    await pool.query(`DELETE FROM platform_posts WHERE resource_ref = $1`, [`instagram:${m.id}`]);
    await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [`instagram:${m.id}`]);
  }
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id = 'der024-ig'`);
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

const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);

test('decisions → a duplicate waits for its source, then one short formatting run; failed / shadow sources; stale; media holds', { skip }, async () => {
  const now = new Date();
  const kyivHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(now));
  if (kyivHour >= 22) return; // the plan needs a slot later today
  const hh = String(kyivHour + 1).padStart(2, '0');

  const groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', 'independent') RETURNING id`, [GROUP])).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'der024_pg', 'Космос', true, $2)`, [CH, groupId]);
  const igId = (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id, last_verified_at) VALUES ('instagram', 'der024-ig', 'X', 't', 'space_ig', $1, now()) RETURNING id`,
    [groupId])).rows[0].id;
  const IG = `instagram:${igId}`;
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({
    ...makeDefaultCard(CH, 'Космос'), mode: 'shadow', planHour: 0, quietStartHour: 23, quietEndHour: 0, postsPerDayMin: 0, postsPerDayMax: 4,
    formats: { photo: 1, text: 1 },
  });
  const agents = new AgentsRepository(pool);
  await new AgentRegistrySync({ agents, channels }).run();
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const repo = new NetworkRepository(pool);
  await repo.insertPlaybook({
    agentId: orch.id, status: 'active', brief: null, createdBy: 'owner', rationale: 'e2e',
    body: {
      platforms: [
        { resource_ref: `telegram:${CH}`, role: 'core', formats: { photo: 1 }, per_day: { min: 0, max: 3 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
        { resource_ref: IG, role: `funnel_to:telegram:${CH}`, formats: { ig_carousel: 1 }, per_day: { min: 0, max: 3 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } },
      ],
      series: [], pillars: [], rules: [],
    } as any,
  });
  const idea = await repo.addIdea({
    agentId: orch.id, title: 'Туманність Кільце від Вебба', sources: ['https://nasa.gov/ring'], variants: [], origin: 'owner',
    expiresAt: new Date(Date.now() + 86_400_000), status: 'accepted',
  });
  const profiles = new ResourceProfilesRepository(pool);
  await profiles.setProfile(IG, ResourceProfileSchema.parse({
    topic: 'Космос для Instagram', audience: { who: 'дорослі, що цікавляться космосом' }, goals: ['growth'], quiet_hours: { start: 23, end: 0 },
  }), 'owner');

  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const posts = new PlatformPostsRepository(pool);
  const files = new SkillLibrary();
  const runtime = new AgentRuntime({ agents, store: new SkillStore(pool), fallback: files });
  const NOTES = 'без емодзі, рівно 2 хештеги';
  const llm = new FakeLlm([
    { calls: [{ name: 'submit_network_plan', args: { rationale: 'Фото з Вебба: TG і той самий пост в IG', slots: [
      { resource_ref: `telegram:${CH}`, time: `${hh}:00`, format: 'photo', topic: idea.title, idea_id: idea.id, reason: 'Ядро мережі, свіжа новина' },
      { resource_ref: IG, time: `${hh}:00`, format: 'ig_photo', topic: idea.title, idea_id: idea.id, treatment: 'duplicate', from_slot: 1,
        reason: 'Та сама аудиторія; фото пасує Instagram як є', format_notes: NOTES },
    ] } }] },
    // The duplicate's formatting run: one publish.
    { calls: [{ name: 'publish_platform_post', args: { spec: {
      format: 'ig_photo', title: idea.title, caption: 'Вебб показав туманність Кільце. Посилання в біо.', hashtags: ['космос', 'вебб'],
      media: [{ url: 'https://images.nasa.gov/ring.jpg', kind: 'image' }], idea_id: idea.id,
    } } }] },
    // The shadow-source duplicate in a live card.
    { calls: [{ name: 'publish_platform_post', args: { spec: {
      format: 'ig_photo', title: 'Кільце ще раз', caption: 'Друге фото туманності: шари газу крупним планом.', hashtags: ['космос'],
      media: [{ url: 'https://images.nasa.gov/ring2.jpg', kind: 'image' }],
    } } }] },
  ]);
  const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), budget: new FakeBudget(), enabled: () => true });
  const noLive = { publish: async () => { throw new Error('no live publishing in tests'); } };
  const registry = new ToolRegistry([
    ...buildNetworkTools({ repo, plans, memory, inbox: new OwnerInbox(pool) }),
    ...buildPlatformTools({ pool, plans, publish: { posts, publisher: noLive, health: async () => null } }),
    ...buildRoleTools({ pool, plans, memory, channels, publisher: { send: async () => { throw new Error('no live publishing in tests'); } }, recordPublish: () => {} }),
  ]);
  const time = new ResourceTime({ card: (k) => channels.get(k), profile: (ref) => profiles.rawProfile(ref), warn: async () => {} });
  const network = new NetworkRunner({ loop, registry, runtime, memory, repo, plans, profiles, env: () => undefined, notify: async () => {}, time });
  const deleted: string[][] = [];
  const holds = new MediaHolds(pool, { delete: async (p) => { deleted.push(p); } });
  const inbox = new OwnerInbox(pool);
  const derived = new DerivedSlots({
    pool, heldUrls: (id) => holds.urls(id),
    networkRefs: async (key) => { const g = await repo.groupOfChannel(key); return g ? [`telegram:${key}`, ...(await repo.groupResources(g.id)).map((r) => r.ref)] : null; },
  });
  const runner = new EditorRunnerService({
    loop, registry, skills: files, runtime, plans, memory, env: () => undefined, notify: async () => {}, network,
    platformContext: (slot, o) => network.platformContext(slot, o),
    derived: {
      resolve: (s) => derived.resolve(s), formatPrefs: async () => 'Хештеги: 2, нижній регістр',
      released: (id) => holds.sweep(new Date(), id),
      inbox: (n) => inbox.post({ agentId: n.agentId, kind: 'derived_post_failed', severity: 'action', title: n.title, body: n.body, refType: 'slot', refId: n.slotId }),
    },
  });
  let card = (await channels.get(CH))!;

  // 1. The planner records one decision per resource; the duplicate points at its source.
  const plan = await runner.runPlanner(card);
  assert.equal(plan.terminalTool, 'submit_network_plan', plan.error);
  const today = localDate(now, 'Europe/Kyiv');
  const { rows: slots } = await pool.query(
    `SELECT s.* FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id WHERE p.channel_key = $1 AND p.plan_date = $2 AND p.status = 'active' ORDER BY s.resource_ref NULLS FIRST`, [CH, today]);
  assert.equal(slots.length, 2);
  const [tgSlot, igSlot] = slots;
  assert.deepEqual([tgSlot.treatment, tgSlot.derived_from_slot_id], ['unique', null]);
  assert.deepEqual([igSlot.treatment, igSlot.derived_from_slot_id, igSlot.source_post.format_notes], ['duplicate', tgSlot.id, NOTES]);
  assert.equal(new Date(igSlot.scheduled_at).getTime(), new Date(tgSlot.scheduled_at).getTime(), 'gap 0 is allowed');
  const { rows: dec } = await pool.query(`SELECT resource_ref, decision, slot_id, decided_by, reason FROM content_decisions WHERE idea_id = $1 ORDER BY decision DESC`, [idea.id]);
  assert.deepEqual(dec.map((d) => [d.resource_ref, d.decision, d.decided_by]), [[`telegram:${CH}`, 'unique', 'planner'], [IG, 'duplicate', 'planner']]);
  assert.equal(dec[1].slot_id, igSlot.id);

  // 2. The duplicate is not claimed while its source is pending — only the source is.
  const due = new Date(new Date(tgSlot.scheduled_at).getTime() + 60_000);
  const first = (await plans.claimDue(due, 10)).filter((s) => s.channelKey === CH);
  assert.deepEqual(first.map((s) => s.id), [tgSlot.id]);
  // Media of the source are held while the duplicate is pending.
  assert.equal(await holds.holdIfDerived(tgSlot.id, ['editor/x/1.png'], ['https://cdn/1.png']), true);
  assert.equal(await holds.holdIfDerived(igSlot.id, ['editor/x/2.png'], ['https://cdn/2.png']), false, 'nothing derives from the duplicate');
  await plans.updateSlot(tgSlot.id, { status: 'shadowed', postSpec: makeSpec({ title: idea.title }) });

  // 3. Now the duplicate runs: one short formatting run with the notes and format_prefs; shadow like its source.
  const second = (await plans.claimDue(due, 10)).filter((s) => s.channelKey === CH);
  assert.deepEqual(second.map((s) => s.id), [igSlot.id]);
  const before = llm.requests.length;
  const res = await runner.runExecutor(second[0], card);
  assert.equal(res.terminalTool, 'publish_platform_post', res.error);
  assert.equal(llm.requests.length - before, 1, 'one LLM call');
  const req = llm.requests.at(-1)!;
  const sys = String(req.messages[0].content);
  assert.match(sys, /## Форматування ресурсу \(format_prefs\)\nХештеги: 2, нижній регістр/);
  assert.match(sys, new RegExp(NOTES));
  assert.deepEqual((req.tools ?? []).map((t) => t.name).sort(), ['lint_platform_post', 'publish_platform_post', 'skip_slot']);
  assert.equal((await plans.getSlot(igSlot.id))!.status, 'shadowed');
  assert.equal((await posts.recent(IG, 1))[0].status, 'shadowed');
  const runs = await pool.query(`SELECT count(*)::int AS n FROM editor_runs WHERE slot_id = $1`, [igSlot.id]);
  assert.equal(runs.rows[0].n, 1);
  // The derived slot finished → the held media of its source are deleted.
  assert.deepEqual(deleted, [['editor/x/1.png']]);
  assert.equal((await pool.query(`SELECT 1 FROM media_holds WHERE slot_id = $1`, [tgSlot.id])).rowCount, 0);

  // 4. A failed source skips its derived slot without an LLM call.
  const d1 = addDays(today, 1);
  const at1 = zonedToUtc(d1, '10:00', 'Europe/Kyiv');
  const s1 = { resourceRef: `telegram:${CH}`, scheduledAt: at1, format: 'photo', topic: 'Т', angle: null, ideaId: null, sourceHints: [], treatment: 'unique' as const };
  const p1 = await plans.createNetworkPlan(CH, d1, 'failed source', null, [s1, { ...s1, resourceRef: IG, format: 'ig_photo', treatment: 'duplicate', fromIndex: 0 }]);
  const [src1, dup1] = (await plans.listSlots(CH, p1)).sort((a, b) => Number(!!a.resourceRef) - Number(!!b.resourceRef));
  await plans.updateSlot(src1.id, { status: 'failed', error: 'boom' });
  const c1 = (await plans.claimDue(new Date(at1.getTime() + 60_000), 10)).filter((s) => s.id === dup1.id);
  const r1 = await runner.runExecutor(c1[0], card);
  assert.equal(r1.error, 'source_failed');
  assert.equal((await plans.getSlot(dup1.id))!.status, 'skipped');
  assert.match((await plans.getSlot(dup1.id))!.error!, /^source_failed/);
  assert.equal(llm.requests.length - before, 1, 'no LLM call for a skipped duplicate');

  // 5. A shadowed source keeps its duplicate shadow, even when the channel is live.
  await channels.upsert({ ...card, mode: 'live' });
  await new AgentRegistrySync({ agents, channels }).run();
  card = (await channels.get(CH))!;
  assert.equal(card.mode, 'live');
  const d2 = addDays(today, 2);
  const at2 = zonedToUtc(d2, '10:00', 'Europe/Kyiv');
  const p2 = await plans.createNetworkPlan(CH, d2, 'shadow source', null, [{ ...s1, scheduledAt: at2 }, { ...s1, scheduledAt: at2, resourceRef: IG, format: 'ig_photo', treatment: 'duplicate', fromIndex: 0 }]);
  const [src2, dup2] = (await plans.listSlots(CH, p2)).sort((a, b) => Number(!!a.resourceRef) - Number(!!b.resourceRef));
  await plans.updateSlot(src2.id, { status: 'shadowed', postSpec: makeSpec({ title: 'Кільце ще раз', media: [{ url: 'https://images.nasa.gov/ring2.jpg' }] }) });
  const c2 = (await plans.claimDue(new Date(at2.getTime() + 60_000), 10)).filter((s) => s.id === dup2.id);
  const r2 = await runner.runExecutor(c2[0], card);
  assert.equal(r2.terminalTool, 'publish_platform_post', r2.error);
  assert.equal((await plans.getSlot(dup2.id))!.status, 'shadowed');
  assert.equal((await posts.recent(IG, 1))[0].status, 'shadowed');

  // 6. A derived slot whose source never finished is skipped as source_not_published after 3 h.
  const d3 = addDays(today, 3);
  const at3 = zonedToUtc(d3, '10:00', 'Europe/Kyiv');
  const p3 = await plans.createNetworkPlan(CH, d3, 'stale', null, [{ ...s1, scheduledAt: at3 }, { ...s1, scheduledAt: at3, resourceRef: IG, format: 'ig_photo', treatment: 'duplicate', fromIndex: 0 }]);
  await plans.skipStale(new Date(at3.getTime() + 4 * 3600_000), 3 * 3600_000);
  const after3 = await plans.listSlots(CH, p3);
  assert.deepEqual(after3.map((s) => [s.resourceRef ?? 'tg', s.error]).sort(), [[IG, 'source_not_published'], ['tg', 'stale: missed its time window']]);

  // 7. A hold that waited 24 h is deleted even while its derived slot is pending.
  const d4 = addDays(today, 4);
  const p4 = await plans.createNetworkPlan(CH, d4, 'hold', null, [{ ...s1, scheduledAt: at3 }, { ...s1, scheduledAt: at3, resourceRef: IG, format: 'ig_photo', treatment: 'duplicate', fromIndex: 0 }]);
  const src4 = (await plans.listSlots(CH, p4)).find((s) => !s.resourceRef)!;
  assert.equal(await holds.holdIfDerived(src4.id, ['editor/x/4.png'], ['https://cdn/4.png']), true);
  assert.equal(await holds.sweep(new Date()), 0, 'still pending, within 24 h');
  assert.equal(await holds.sweep(new Date(Date.now() + 25 * 3600_000)), 1);
  assert.deepEqual(deleted.at(-1), ['editor/x/4.png']);
});
