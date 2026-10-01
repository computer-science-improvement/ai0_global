/** Agent registry + DB skills against a real throwaway Postgres (049). Skipped unless EDITOR_PG_TEST_URL is set. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from './agents.repository';
import { AgentRegistrySync } from './agent-registry-sync';
import { SkillStore } from './skill-store';
import { OwnerInbox } from './owner-inbox';
import { AgentRuntime } from './agent-runtime';
import { SkillVersionEvaluator } from './skill-version-evaluator';
import { buildAgentSkillTools } from './agent-skill-tools';
import type { KpiPoint, ScopeKpi } from './scope-kpi';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';
import { SkillLibrary } from '../skills/skill-library';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@agents_pg_test';
const CH2 = '@Agents-PG.Test';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM agents WHERE scope_id IN ($1, $2)`, [`telegram:${CH}`, `telegram:${CH2}`]);
  await pool.query(`DELETE FROM skills WHERE scope = 'agent' AND agent_id IS NULL`);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key IN ($1, $2)`, [CH, CH2]);
  await pool.query(`DELETE FROM agent_inbox WHERE kind LIKE 'skill_%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({ ...makeDefaultCard(CH), mode: 'shadow', title: 'Агенти ПГ' });
  await channels.insertIfMissing({ ...makeDefaultCard(CH2), mode: 'off' });
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const files = () => new SkillLibrary();

test('registry sync: an orchestrator + role children per card; idempotent; mode follows the card', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const sync = new AgentRegistrySync({ agents, channels });
  await sync.run();
  const again = await sync.run();
  assert.equal(again.created, 0, 'second run creates nothing');

  const orch = await agents.findTop('orchestrator', 'resource', `telegram:${CH}`);
  assert.ok(orch);
  assert.equal(orch!.mode, 'shadow');
  const kids = await agents.children(orch!.id);
  assert.deepEqual(kids.map((k) => k.kind).sort(), ['executor', 'idea_reviewer', 'planner', 'reviewer']);

  // Two cards whose derived handles collide: one gets a suffix.
  const orch2 = await agents.findTop('orchestrator', 'resource', `telegram:${CH2}`);
  assert.deepEqual([orch!.handle, orch2!.handle].sort(), ['agents_pg_test', 'agents_pg_test_2']);

  await pool.query(`UPDATE editor_channels SET mode = 'live' WHERE channel_key = $1`, [CH]);
  await sync.run();
  assert.equal((await agents.get(orch!.id))!.mode, 'live');
  await pool.query(`UPDATE editor_channels SET mode = 'shadow' WHERE channel_key = $1`, [CH]);
  await sync.run();
});

test('rename keeps the old handle as an alias', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const old = orch.handle;
  await agents.update(orch.id, { handle: 'kira_pg' });
  assert.equal((await agents.getByHandle('@kira_pg'))!.id, orch.id);
  assert.equal((await agents.getByHandle(old))!.id, orch.id, 'alias resolves');
  assert.equal(await agents.handleTaken(old), true, 'an alias blocks reuse by others');
  assert.equal(await agents.handleTaken(old, orch.id), false, 'but not for its own agent');
  await agents.update(orch.id, { handle: old });
  assert.equal((await agents.getByHandle(old))!.id, orch.id);
  await pool.query(`DELETE FROM agent_handle_aliases WHERE agent_id = $1`, [orch.id]);
});

test('skills: builtin sync, override, toggles, inheritance by role children, versions and rollback', { skip }, async () => {
  const store = new SkillStore(pool);
  const lib = files();
  await store.syncBuiltins(lib);
  const second = await store.syncBuiltins(lib);
  assert.deepEqual(second, { inserted: 0, updated: 0 });

  const agents = new AgentsRepository(pool);
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const exec = (await agents.findChild(orch.id, 'executor'))!;

  // Owner overrides a builtin for the orchestrator; the executor inherits it.
  const base = lib.get('format-hashtags')!;
  const w = await store.writeAgentSkill({
    agentId: orch.id, name: 'format-hashtags', description: base.description, appliesTo: base.appliesTo,
    body: `${base.body}\n\n## Канал\nЗавжди #космос першим.`, author: 'owner',
  });
  assert.ok('ok' in w);
  let view = await store.resolveForAgent([exec.id, orch.id], 'executor');
  assert.match(view.get('format-hashtags')!.body, /#космос першим/);
  const entries = await store.listForAgent([orch.id]);
  assert.equal(entries.find((e) => e.skill.name === 'format-hashtags')!.origin, 'override');
  assert.equal((await store.listForAgent([exec.id, orch.id])).find((e) => e.skill.name === 'format-hashtags')!.origin, 'inherited');

  // Disable a builtin for the orchestrator → gone for the executor too; inline flag lands in the view.
  const anti = (await store.findShared('anti-slop'))!;
  await store.setToggle(orch.id, anti.id, { enabled: false });
  const human = (await store.findShared('human-voice'))!;
  await store.setToggle(orch.id, human.id, { inline: true });
  view = await store.resolveForAgent([exec.id, orch.id], 'executor');
  assert.equal(view.get('anti-slop'), undefined);
  assert.ok(view.inlineNames().includes('human-voice'));

  // Agent self-edit on top of an owner version is refused; safety skills are refused.
  const refused = await store.writeAgentSkill({
    agentId: orch.id, name: 'format-hashtags', description: base.description, appliesTo: base.appliesTo, body: 'нове', author: 'agent',
  });
  assert.equal((refused as any).error, 'owner_authored');
  const safety = await store.writeAgentSkill({
    agentId: orch.id, name: 'fact-check', description: 'Перевірка фактів — моя версія', appliesTo: ['executor'], body: 'менше перевірок', author: 'agent',
  });
  assert.equal((safety as any).error, 'safety_skill');

  // Versions + rollback create a new version with the old text.
  const s = (await store.findForAgent(orch.id, 'format-hashtags'))!;
  await store.writeAgentSkill({ agentId: orch.id, name: 'format-hashtags', description: base.description, appliesTo: base.appliesTo, body: 'v2 body text', author: 'owner' });
  const rb = await store.rollback(s.id, 1, 'owner', 'test');
  assert.ok('ok' in rb && rb.version === 3);
  assert.match((await store.get(s.id))!.body, /#космос першим/);
  assert.deepEqual((await store.versions(s.id)).map((v) => v.version), [3, 2, 1]);

  // Reset to default removes the override.
  assert.equal(await store.deleteAgentSkill(orch.id, 'format-hashtags'), true);
  await store.setToggle(orch.id, anti.id, { enabled: true });
  await store.setToggle(orch.id, human.id, { inline: false });
});

test('runtime: resolves the role child, its skills and pause', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const runtime = new AgentRuntime({ agents, store: new SkillStore(pool), fallback: files() });
  const ctx = await runtime.forChannel(CH, 'executor');
  assert.equal(ctx.agent!.kind, 'executor');
  assert.equal(ctx.orchestrator!.kind, 'orchestrator');
  assert.ok(ctx.skills.get('format-carousel'));
  assert.equal(ctx.paused, false);
  await agents.update(ctx.orchestrator!.id, { pausedUntil: new Date(Date.now() + 3600_000) });
  assert.equal((await runtime.forChannel(CH, 'planner')).paused, true, 'a paused orchestrator pauses its roles');
  await agents.update(ctx.orchestrator!.id, { pausedUntil: null });
  const none = await runtime.forChannel('@no_such_channel', 'executor');
  assert.equal(none.agent, null);
});

test('self-edit tool → inbox → evaluator rolls back on a KPI drop', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const store = new SkillStore(pool);
  const inbox = new OwnerInbox(pool);
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const reviewer = (await agents.findChild(orch.id, 'reviewer'))!;
  let kpiNow: KpiPoint = { metric: 'views_per_post', value7d: 1000, baseline28d: 1000, std28d: 80, posts7d: 12, postsBase: 50, at: '' };
  const kpi: ScopeKpi = { primary: async () => kpiNow };
  const [tool] = buildAgentSkillTools({ agents, skills: store, kpi, inbox });
  const ctx = { runId: 'r', role: 'reviewer' as const, channelKey: CH, extras: { agent: reviewer } };

  const res: any = await tool.execute({
    skill: 'seasonal-hooks', description: 'Сезонні гачки для перших рядків постів', applies_to: ['executor'],
    body: 'Починай пост із сезонної деталі: погода, свята, урожай.', reason: 'пости з сезонним першим рядком мали +30% переглядів за 28 днів',
  }, ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  const again: any = await tool.execute({ skill: 'seasonal-hooks', body: 'ще одна зміна в той самий день', reason: 'друга спроба в той самий день — має бути відмова' }, ctx);
  assert.equal(again.error, 'self_edit_limit');
  const items = await inbox.list({ unreadOnly: true });
  assert.ok(items.some((i) => i.kind === 'skill_self_edit' && /seasonal-hooks/.test(i.title)));

  // Owned by the orchestrator (reviewer acted for its scope), visible to the executor.
  const runtime = new AgentRuntime({ agents, store, fallback: files() });
  assert.ok((await runtime.forChannel(CH, 'executor')).skills.get('seasonal-hooks'));

  // 7 days later the KPI dropped 30% → rolled back (a v1 agent skill is removed).
  kpiNow = { ...kpiNow, value7d: 700 };
  const evaluator = new SkillVersionEvaluator({ skills: store, agents, kpi, inbox });
  const r = await evaluator.run(new Date(Date.now() + 8 * 86_400_000));
  assert.equal(r.rolledBack, 1);
  assert.equal(await store.findForAgent(orch.id, 'seasonal-hooks'), null);
  assert.ok((await inbox.list({ unreadOnly: true })).some((i) => i.kind === 'skill_rolled_back'));
  await pool.query(`DELETE FROM skill_versions WHERE author_agent_id = $1`, [reviewer.id]);
});
