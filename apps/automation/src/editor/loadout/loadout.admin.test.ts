import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool } from '../harness/tool';
import { ToolRegistry } from '../harness/tool-registry';
import type { Agent } from '../agents/agent.types';
import type { AgentSkillEntry } from '../agents/skill-store';
import type { LoadoutMode } from './loadout.repository';
import { LoadoutAdminService } from './loadout.admin.service';
import { LoadoutCreation, resourcePlatforms } from './loadout-creation';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { emptyUsage, type AgentUsage } from './loadout-usage';
import { buildLoadoutView } from './loadout-view';
import { makeDefaultCard } from '../chat/default-card';

const mk = (name: string, kind: any = 'read', roles: any[] = ['executor'], extra: object = {}) =>
  defineTool({ name, description: `${name} does a thing`, input: z.object({ q: z.string().optional() }), kind, roles, ...extra, execute: async () => ({ ok: true }) });

const CORE = ['load_skill', 'fetch_feed', 'fetch_api', 'web_fetch', 'library_catalog', 'query_data', 'check_similarity'];
const registry = () => new ToolRegistry([
  ...CORE.map((n) => mk(n)), mk('get_top_posts'), mk('get_recent_posts'), mk('lint_post'), mk('sql_readonly'), mk('act_x', 'act'),
  mk('publish_post', 'terminal'), mk('skip_slot', 'terminal'), mk('chat_only_tool', 'act', ['executor'], { chatOnly: true }), mk('plan_tool', 'read', ['planner']),
]);

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', kind: 'executor', scope: 'resource', scopeId: 'telegram:@ch', parentId: 'o1', name: 'Exec', handle: 'ch_executor', emoji: null, description: null,
  mode: 'live', status: 'active', pausedUntil: null, model: null, reasoningEffort: null, schedule: {}, dailyBudgetUsd: null, shadowUntil: null,
  createdBy: 'sync', createdAt: new Date(), updatedAt: new Date(), ...over,
});

function setup(initial: { mode?: LoadoutMode; enabled?: string[]; usage?: AgentUsage; skills?: AgentSkillEntry[]; peers?: { runs: number; rates: Map<string, number> } } = {}) {
  const state = { mode: initial.mode ?? 'role', enabled: initial.enabled ?? [] as string[], by: '', toggled: [] as Array<[string, string, boolean | undefined]> };
  const a = agent();
  const svc = new LoadoutAdminService({
    agents: { getByHandle: async (h: string) => (h === a.handle ? a : null), get: async () => agent({ id: 'o1', kind: 'orchestrator', parentId: null }) } as any,
    repo: {
      mode: async () => state.mode,
      enabledTools: async () => state.enabled,
      setTools: async (_id: string, names: string[], by: string) => { state.mode = 'custom'; state.enabled = names; state.by = by; },
      reset: async () => { state.mode = 'role'; state.enabled = []; },
    },
    usage: { forAgents: async () => new Map([[a.id, initial.usage ?? emptyUsage()]]), peerRates: async () => initial.peers ?? { runs: 0, rates: new Map() } },
    registry: registry(),
    skills: { listForAgent: async () => initial.skills ?? [], setToggle: async (agentId: string, skillId: string, p: { enabled?: boolean }) => { state.toggled.push([agentId, skillId, p.enabled]); } },
    rules: async () => ({ ownerRules: 2, memory: 5, steeringSets: 1, playbookRules: 3, chars: 900 }),
  });
  return { svc, state, a };
}

const names = (v: { tools: Array<{ name: string }> }) => v.tools.map((t) => t.name);

test('view in mode role: every available tool is enabled; core, terminal and the writer\'s denied tools are marked', async () => {
  const { svc } = setup();
  const v = await svc.view('ch_executor');
  assert.equal(v.mode, 'role');
  assert.equal(v.role, 'executor');
  assert.ok(!names(v).includes('chat_only_tool') && !names(v).includes('plan_tool'), 'only the role\'s runnable-in-schedule tools');
  const row = (n: string) => v.tools.find((t) => t.name === n)!;
  assert.deepEqual([row('fetch_feed').core, row('get_top_posts').core, row('publish_post').core], [true, false, true]);
  assert.equal(row('sql_readonly').available, false);
  assert.equal(row('sql_readonly').enabled, false);
  assert.equal(row('get_top_posts').enabled, true);
  // read, act, terminal; names alphabetical inside a kind
  assert.deepEqual(v.tools.map((t) => t.kind).filter((k, i, all) => all.indexOf(k) === i), ['read', 'act', 'terminal']);
  assert.equal(v.tokens.current, v.tokens.roleDefault, 'nothing is narrowed in mode role');
  assert.deepEqual(v.rules, { ownerRules: 2, memory: 5, steeringSets: 1, playbookRules: 3, chars: 900 });
  assert.deepEqual(v.suggestions, []);
});

test('PUT tools: custom mode, the given set, terminal tools kept, tokens drop', async () => {
  const { svc, state } = setup();
  const before = (await svc.view('ch_executor')).tokens;
  const v = await svc.putTools('ch_executor', { tools: [...CORE, 'get_top_posts'] });
  assert.equal(v.mode, 'custom');
  assert.equal(state.by, 'owner');
  const want = new Set([...CORE, 'get_top_posts', 'publish_post', 'skip_slot']);
  assert.deepEqual(state.enabled, registry().all().map((t) => t.name).filter((n) => want.has(n)), 'registry order');
  assert.equal(v.tools.find((t) => t.name === 'get_recent_posts')!.enabled, false);
  assert.equal(v.tools.find((t) => t.name === 'get_top_posts')!.enabled, true);
  assert.equal(v.tools.find((t) => t.name === 'publish_post')!.enabled, true);
  assert.ok(v.tokens.current < before.current);
  assert.equal(v.tokens.roleDefault, before.roleDefault);
});

test('PUT tools refuses an unknown tool and a dropped core tool; nothing is written', async () => {
  const { svc, state } = setup();
  await assert.rejects(svc.putTools('ch_executor', { tools: [...CORE, 'nope'] }), (e: any) => e.getResponse().error === 'unknown_tool' && e.getResponse().tools[0] === 'nope');
  await assert.rejects(svc.putTools('ch_executor', { tools: ['plan_tool'] }), (e: any) => e.getResponse().error === 'unknown_tool', 'a tool of another role');
  await assert.rejects(svc.putTools('ch_executor', { tools: CORE.filter((n) => n !== 'fetch_feed') }), (e: any) => e.getResponse().error === 'core_tool' && e.getResponse().tools.includes('fetch_feed'));
  await assert.rejects(svc.putTools('ch_executor', { tools: 'all' }), (e: any) => e.getResponse().error === 'invalid_body');
  assert.equal(state.mode, 'role');
  await assert.rejects(svc.view('nobody'), (e: any) => e.getResponse().error === 'agent_not_found');
});

test('reset returns to the role default', async () => {
  const { svc } = setup({ mode: 'custom', enabled: CORE });
  assert.equal((await svc.view('ch_executor')).mode, 'custom');
  const v = await svc.reset('ch_executor');
  assert.equal(v.mode, 'role');
  assert.ok(v.tools.find((t) => t.name === 'get_top_posts')!.enabled);
});

test('view: usage figures and the skills of the role', async () => {
  const usage = emptyUsage();
  usage.runs = 12;
  usage.tools.set('fetch_feed', { calls: 30, errors: 2, lastUsedAt: new Date('2026-10-19T10:00:00Z') });
  usage.loads.set('format-poll-quiz', { loads: 3, lastLoadedAt: new Date('2026-10-18T10:00:00Z') });
  const skill = (name: string, appliesTo: string[], enabled: boolean, inline = false): AgentSkillEntry => ({
    skill: { name, scope: 'builtin', appliesTo, body: 'x'.repeat(100) } as any, origin: 'builtin', enabled, inline, baseChanged: false, pending: false,
  });
  const { svc } = setup({ usage, skills: [skill('format-poll-quiz', ['executor'], true), skill('idea-review', ['idea_reviewer'], true), skill('anti-slop', ['executor'], false, false)] });
  const v = await svc.view('ch_executor');
  assert.equal(v.runs30d, 12);
  assert.deepEqual([v.tools.find((t) => t.name === 'fetch_feed')!.calls30d, v.tools.find((t) => t.name === 'fetch_feed')!.errors30d], [30, 2]);
  assert.deepEqual(v.skills.map((s) => [s.name, s.enabled, s.loads30d, s.chars]), [['format-poll-quiz', true, 3, 100], ['anti-slop', false, 0, 100]]);
});

test('buildLoadoutView: a custom loadout lists only its enabled tools as enabled', () => {
  const v = buildLoadoutView({
    role: 'executor', mode: 'custom', enabled: ['fetch_feed'], tools: registry().all(), usage: emptyUsage(), skills: [],
    rules: { ownerRules: 0, memory: 0, steeringSets: 0, playbookRules: 0, chars: 0 },
  });
  assert.deepEqual(v.tools.filter((t) => t.enabled).map((t) => t.name), ['fetch_feed', 'publish_post', 'skip_slot']);
});

// ── creation ─────────────────────────────────────────────────────────────────

function creation(opts: { registry?: boolean; peers?: string[]; platforms?: string[]; fail?: boolean } = {}) {
  const wrote: Array<{ id: string; names: string[]; by: string }> = [];
  const c = new LoadoutCreation({
    repo: { initTools: async (id: string, names: string[], by: any) => { if (opts.fail) throw new Error('db down'); wrote.push({ id, names, by }); return true; } },
    usage: { peerTools: async () => opts.peers ?? [] },
    registry: () => (opts.registry === false ? null : registry()),
    platforms: async () => (opts.platforms ?? ['telegram']) as any,
  });
  return { c, wrote };
}

test('creation: core tools, Telegram tools, peers\' tools — written once as the creation author', async () => {
  const { c, wrote } = creation({ peers: ['get_top_posts'] });
  assert.equal(await c.form(agent()), true);
  assert.equal(wrote[0].by, 'creation');
  const want = new Set([...CORE, 'get_top_posts', 'lint_post', 'publish_post', 'skip_slot']);
  assert.deepEqual(wrote[0].names, registry().all().map((t) => t.name).filter((n) => want.has(n)));
});

test('creation never throws: no registry yet or a failing database leaves the role default', async () => {
  assert.equal(await creation({ registry: false }).c.form(agent()), false);
  assert.equal(await creation({ fail: true }).c.form(agent()), false);
});

test('resourcePlatforms: a Telegram resource adds its network\'s platforms; others are their own', async () => {
  const p = resourcePlatforms(async () => ['telegram', 'instagram']);
  assert.deepEqual((await p(agent())).sort(), ['instagram', 'telegram']);
  assert.deepEqual(await resourcePlatforms(async () => ['telegram'])(agent({ scopeId: 'instagram:77' })), ['instagram']);
  assert.deepEqual(await p(agent({ scope: 'system', scopeId: null })), []);
  assert.deepEqual(await resourcePlatforms(async () => { throw new Error('x'); })(agent()), ['telegram']);
});

test('registry sync forms a loadout for the agents it creates and for no other', async () => {
  const formed: string[] = [];
  const existing = agent({ id: 'o-existing', kind: 'orchestrator', parentId: null, scopeId: 'telegram:@old', handle: 'old' });
  const inserted: Agent[] = [];
  const agents = {
    findTop: async (_k: string, _s: string, scopeId: string) => (scopeId === 'telegram:@old' ? existing : null),
    findChild: async (_p: string, kind: string) => (existing.id === _p ? agent({ id: `c-${kind}`, kind: kind as any }) : null),
    insert: async (a: any) => { const x = agent({ ...a, id: `new-${inserted.length}` }); inserted.push(x); return x; },
    update: async () => null, allHandles: async () => new Set<string>(), linkLegacyRuns: async () => 0,
  };
  const sync = new AgentRegistrySync({
    agents: agents as any,
    channels: { list: async () => [makeDefaultCard('@old', 'Old'), makeDefaultCard('@fresh', 'Fresh')] },
    loadout: { form: async (a) => { formed.push(a.id); } },
  });
  await sync.run();
  // Spec 055: the sync also creates @sysadmin; its tools are its runner's own short list, so it gets no loadout.
  const channelAgents = inserted.filter((a) => a.kind !== 'auditor');
  assert.equal(channelAgents.length, 5, 'the fresh channel\'s orchestrator and its four role children');
  assert.deepEqual(formed, channelAgents.map((a) => a.id), 'a loadout for each new agent, none for the existing channel\'s agents nor @sysadmin');
});

// ── suggestions and apply (FR-005) ───────────────────────────────────────────

const entry = (name: string, id: string, over: Partial<AgentSkillEntry> = {}, safety = false): AgentSkillEntry => ({
  skill: { id, name, scope: 'builtin', appliesTo: ['executor'], body: 'x'.repeat(50), safety } as any, origin: 'builtin', enabled: true, inline: false, baseChanged: false, pending: false, ...over,
});

function busy(): AgentUsage {
  const u = emptyUsage();
  u.runs = 20;
  u.offered = new Map([['get_recent_posts', 20], ['fetch_feed', 20], ['act_x', 20]]);
  u.tools.set('act_x', { calls: 4, errors: 0, lastUsedAt: new Date() });
  u.denied.set('lint_post', 3);
  return u;
}

test('view: suggestions come from the usage, the peers and the skills', async () => {
  const { svc } = setup({
    mode: 'custom', enabled: [...CORE, 'get_recent_posts', 'old_tool'], usage: busy(),
    peers: { runs: 30, rates: new Map([['get_top_posts', 0.5]]) }, skills: [entry('format-poll-quiz', 's1')],
  });
  const v = await svc.view('ch_executor');
  assert.deepEqual(v.suggestions.map((s) => s.id), ['missing:lint_post', 'peer:get_top_posts', 'unused:get_recent_posts', 'stale:old_tool', 'skills_unused:format-poll-quiz']);
});

test('apply: add and remove on top of the effective tools, written as "recommend", terminal kept', async () => {
  const { svc, state } = setup({ mode: 'custom', enabled: [...CORE, 'get_recent_posts', 'old_tool', 'publish_post', 'skip_slot'], usage: busy() });
  const v = await svc.apply('ch_executor', { add: ['lint_post', 'get_top_posts'], remove: ['get_recent_posts', 'old_tool'] });
  assert.equal(state.by, 'recommend');
  assert.equal(v.mode, 'custom');
  const want = new Set([...CORE, 'lint_post', 'get_top_posts', 'publish_post', 'skip_slot']);
  assert.deepEqual(state.enabled, registry().all().map((t) => t.name).filter((n) => want.has(n)), 'the stale name is gone');
});

test('apply from mode role: the role default minus a removed tool becomes a custom loadout', async () => {
  const { svc, state } = setup();
  const v = await svc.apply('ch_executor', { remove: ['get_recent_posts'] });
  assert.equal(state.mode, 'custom');
  assert.ok(!state.enabled.includes('get_recent_posts') && state.enabled.includes('get_top_posts') && state.enabled.includes('publish_post'));
  assert.equal(v.tools.find((t) => t.name === 'get_recent_posts')!.enabled, false);
});

test('apply is validated like a PUT: core tools stay, unknown names to add are refused', async () => {
  const { svc, state } = setup({ mode: 'custom', enabled: CORE });
  await assert.rejects(svc.apply('ch_executor', { remove: ['fetch_feed'] }), (e: any) => e.getResponse().error === 'core_tool');
  await assert.rejects(svc.apply('ch_executor', { add: ['nope'] }), (e: any) => e.getResponse().error === 'unknown_tool');
  await assert.rejects(svc.apply('ch_executor', { add: 'x' }), (e: any) => e.getResponse().error === 'invalid_body');
  await assert.rejects(svc.apply('ch_executor', { add: [], extra: 1 }), (e: any) => e.getResponse().error === 'invalid_body');
  assert.deepEqual(state.enabled, CORE, 'nothing was written');
});

test('apply: disableSkills switches the agent toggle off; a safety skill or an unknown one is refused; a skill-only apply keeps the mode', async () => {
  const other = entry('planner-only', 's3');
  other.skill = { ...other.skill, appliesTo: ['planner'] };
  const skills = [entry('format-poll-quiz', 's1'), entry('anti-slop', 's2', {}, true), other];
  const { svc, state } = setup({ skills });
  const v = await svc.apply('ch_executor', { disableSkills: ['format-poll-quiz'] });
  assert.deepEqual(state.toggled, [['a1', 's1', false]]);
  assert.equal(v.mode, 'role', 'only a skill changed');
  await assert.rejects(svc.apply('ch_executor', { disableSkills: ['anti-slop'] }), (e: any) => e.getResponse().error === 'safety_skill');
  await assert.rejects(svc.apply('ch_executor', { disableSkills: ['planner-only'] }), (e: any) => e.getResponse().error === 'unknown_skill');
  await assert.rejects(svc.apply('ch_executor', { disableSkills: ['ghost'] }), (e: any) => e.getResponse().error === 'unknown_skill');
  assert.equal(state.toggled.length, 1);
});

test('an empty apply changes nothing', async () => {
  const { svc, state } = setup();
  const v = await svc.apply('ch_executor', {});
  assert.equal(v.mode, 'role');
  assert.equal(state.by, '');
});
