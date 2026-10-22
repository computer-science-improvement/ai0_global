/**
 * Spec 054 T2 against a throwaway Postgres (its own database): the usage queries (runs, offered tools, calls, errors,
 * refused calls, skill loads, peers; the 30-day window), the rules summary, and the loadout of a new agent made by the
 * registry sync (peers' tools in, existing agents untouched). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Pool } from 'pg';
import { defineTool } from '../harness/tool';
import { ToolRegistry } from '../harness/tool-registry';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';
import { LoadoutRepository } from './loadout.repository';
import { LoadoutUsage } from './loadout-usage';
import { LoadoutCreation, resourcePlatforms } from './loadout-creation';
import { rulesSummary } from './loadout-rules';
import { createLoadoutDb, type LoadoutDb } from './testing/loadout-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;

let db: LoadoutDb;
let pool: Pool;
let usage: LoadoutUsage;
let exec1: string;
let exec2: string;

async function run(agentId: string, role: string, o: { offered?: string[]; daysAgo?: number; channel?: string } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_runs (role, channel_key, model, agent_id, tools_offered, status, started_at)
     VALUES ($1, $2, 'm', $3, $4, 'ok', now() - make_interval(days => $5)) RETURNING id`,
    [role, o.channel ?? '@lo_usage', agentId, o.offered ?? null, o.daysAgo ?? 0]);
  return rows[0].id;
}
async function step(runId: string, idx: number, tool: string, o: { error?: string; input?: object; daysAgo?: number } = {}) {
  await pool.query(
    `INSERT INTO editor_run_steps (run_id, idx, type, tool_name, input, output, is_error, created_at)
     VALUES ($1, $2, 'tool', $3, $4, $5, $6, now() - make_interval(days => $7))`,
    [runId, idx, tool, JSON.stringify(o.input ?? {}), JSON.stringify(o.error ? { error: o.error } : { ok: true }), !!o.error, o.daysAgo ?? 0]);
}

before(async () => {
  if (!url) return;
  db = await createLoadoutDb(url, 'usage');
  pool = db.pool;
  usage = new LoadoutUsage(pool);
  const agents = new AgentsRepository(pool);
  const mkAgent = (handle: string) => agents.insert({ kind: 'executor', scope: 'resource', scopeId: `telegram:@${handle}`, name: handle, handle, createdBy: 'sync' });
  exec1 = (await mkAgent('lo_usage_one')).id;
  exec2 = (await mkAgent('lo_usage_two')).id;
});
after(async () => { if (db) await db.drop(); });

test('usage: runs, offered tools, calls, errors, refused calls and skill loads of the last 30 days', { skip }, async () => {
  const r1 = await run(exec1, 'executor', { offered: ['fetch_feed', 'web_fetch', 'get_top_posts'] });
  const r2 = await run(exec1, 'executor', { offered: ['fetch_feed', 'web_fetch'] });
  await run(exec1, 'executor', { offered: ['fetch_feed'], daysAgo: 45 });
  await run(exec1, 'executor');
  await step(r1, 0, 'fetch_feed');
  await step(r1, 1, 'fetch_feed', { error: 'tool_failed' });
  await step(r1, 2, 'web_fetch');
  await step(r2, 0, 'sql_readonly', { error: 'tool_not_allowed' });
  await step(r2, 1, 'sql_readonly', { error: 'tool_not_allowed' });
  await step(r2, 2, 'load_skill', { input: { name: 'format-poll-quiz' } });
  await step(r2, 3, 'load_skill', { input: { name: 'format-poll-quiz' } });
  await step(r2, 4, 'load_skill', { input: { name: 'no-such-skill' }, error: 'unknown_skill' });
  await step(r2, 5, 'fetch_feed', { daysAgo: 40 });

  const u = (await usage.forAgents([exec1])).get(exec1)!;
  assert.equal(u.runs, 3, 'the 45-day-old run is out of the window');
  assert.deepEqual([...u.offered].sort(), [['fetch_feed', 2], ['get_top_posts', 1], ['web_fetch', 2]]);
  assert.equal(u.tools.get('fetch_feed')!.calls, 2);
  assert.equal(u.tools.get('fetch_feed')!.errors, 1);
  assert.ok(u.tools.get('fetch_feed')!.lastUsedAt instanceof Date);
  assert.equal(u.tools.get('web_fetch')!.errors, 0);
  assert.equal(u.tools.has('sql_readonly'), false, 'a refused call is not a use of the tool');
  assert.equal(u.denied.get('sql_readonly'), 2);
  assert.deepEqual(u.loads.get('format-poll-quiz')!.loads, 2);
  assert.equal(u.loads.has('no-such-skill'), false, 'a failed load is not a load');
});

test('usage: an agent with no runs is empty; the other agent\'s runs do not leak', { skip }, async () => {
  const none = (await usage.forAgents([exec2, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'])).get(exec2)!;
  assert.equal(none.runs, 0);
  assert.equal(none.tools.size, 0);
  assert.equal((await usage.forAgents([])).size, 0);
});

test('peers: the share of the role\'s runs that called a tool, without the agent itself and without refused calls', { skip }, async () => {
  for (let i = 0; i < 6; i++) {
    const r = await run(exec2, 'executor', { offered: ['fetch_feed', 'get_top_posts'] });
    await step(r, 0, 'fetch_feed');
    if (i < 2) await step(r, 1, 'get_top_posts');
    if (i === 5) await step(r, 2, 'sql_readonly', { error: 'tool_not_allowed' });
    // a repeated call in one run counts once
    await step(r, 3, 'fetch_feed');
  }
  const peers = await usage.peerRates('executor', [exec1]);
  assert.equal(peers.runs, 6);
  assert.equal(peers.rates.get('fetch_feed'), 1);
  assert.ok(Math.abs(peers.rates.get('get_top_posts')! - 2 / 6) < 1e-9);
  assert.equal(peers.rates.has('sql_readonly'), false);
  assert.deepEqual(await usage.peerTools('executor', [exec1], 0.2, 5), ['fetch_feed', 'get_top_posts']);
  assert.deepEqual(await usage.peerTools('executor', [exec1], 0.5, 5), ['fetch_feed']);
  assert.deepEqual(await usage.peerTools('executor', [exec1], 0.2, 7), [], 'too few runs of peers say nothing');
  assert.deepEqual(await usage.peerTools('planner', [exec1], 0.2, 1), [], 'another role');
});

test('rules summary: owner rules, memory, steering rules and playbook rules of the channel', { skip }, async () => {
  const CH = '@lo_rules';
  await new EditorChannelsRepository(pool).insertIfMissing(makeDefaultCard(CH, 'Rules'));
  const mem = (kind: string, text: string, by: string, active = true) =>
    pool.query(`INSERT INTO editor_channel_memory (channel_key, kind, text, created_by, active) VALUES ($1, $2, $3, $4, $5)`, [CH, kind, text, by, active]);
  await mem('rule', 'No politics', 'owner');
  await mem('avoid', 'No crypto', 'owner');
  await mem('rule', 'Retired rule', 'owner', false);
  await mem('insight', 'Photos win at 19:00', 'reviewer');
  await mem('rule', 'Reviewer rule', 'reviewer');
  const orch = await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, name: 'Rules', handle: 'lo_rules', createdBy: 'sync' });
  await pool.query(
    `INSERT INTO steering_sets (target_ref, source_ref, status, rules) VALUES ($1, 'telegram:@ref', 'active', $2), ($1, 'telegram:@old', 'superseded', $3)`,
    [`telegram:${CH}`,
      JSON.stringify([{ enabled: true, conflict: null, text: 'abcde' }, { enabled: false, conflict: null, text: 'off' }, { enabled: true, conflict: { with: 'x', note: 'y' }, text: 'conflicts' }]),
      JSON.stringify([{ enabled: true, conflict: null, text: 'old rule' }])]);
  await pool.query(`INSERT INTO playbooks (agent_id, version, status, body, created_by) VALUES ($1, 1, 'active', $2, 'owner')`,
    [orch.id, JSON.stringify({ rules: ['one', 'three'] })]);

  const r = await rulesSummary(pool, { channelKey: CH, resourceRef: `telegram:${CH}`, orchestratorId: orch.id });
  assert.equal(r.ownerRules, 2);
  assert.equal(r.memory, 2);
  assert.equal(r.steeringSets, 1);
  assert.equal(r.playbookRules, 2);
  const chars = 'No politics'.length + 'No crypto'.length + 'Photos win at 19:00'.length + 'Reviewer rule'.length + 'abcde'.length + 'one'.length + 'three'.length;
  assert.equal(r.chars, chars);
  assert.deepEqual(await rulesSummary(pool, { channelKey: null, resourceRef: null, orchestratorId: null }), { ownerRules: 0, memory: 0, steeringSets: 0, playbookRules: 0, chars: 0 });
  const none = await rulesSummary(pool, { channelKey: '@lo_none', resourceRef: 'telegram:@lo_none', orchestratorId: null });
  assert.deepEqual(none, { ownerRules: 0, memory: 0, steeringSets: 0, playbookRules: 0, chars: 0 });
});

test('registry sync forms the loadout of a new channel\'s agents (peers\' tools in) and leaves existing agents alone', { skip }, async () => {
  const mk = (name: string, kind: any = 'read', roles: any[] = ['executor']) =>
    defineTool({ name, description: name, input: z.object({}), kind, roles, execute: async () => ({ ok: true }) });
  const registry = new ToolRegistry([
    ...['load_skill', 'fetch_feed', 'fetch_api', 'web_fetch', 'library_catalog', 'query_data', 'check_similarity'].map((n) => mk(n)),
    mk('get_top_posts'), mk('get_recent_posts'), mk('lint_post'), mk('lint_platform_post'),
    mk('publish_post', 'terminal'), mk('skip_slot', 'terminal'), mk('get_channel_stats', 'read', ['planner', 'executor']), mk('submit_plan', 'terminal', ['planner']),
    mk('list_ideas', 'read', ['orchestrator']), mk('finish_orchestration', 'terminal', ['orchestrator']),
  ]);
  const agents = new AgentsRepository(pool);
  const loadoutRepo = new LoadoutRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const creation = new LoadoutCreation({
    repo: loadoutRepo, usage, registry: () => registry, platforms: resourcePlatforms(async () => []),
  });
  // an existing channel whose agents were made before the loadout existed
  await channels.insertIfMissing({ ...makeDefaultCard('@lo_old', 'Old'), mode: 'shadow' });
  await new AgentRegistrySync({ agents, channels }).run();
  const oldOrch = (await agents.findTop('orchestrator', 'resource', 'telegram:@lo_old'))!;
  const oldExec = (await agents.findChild(oldOrch.id, 'executor'))!;
  assert.equal(await loadoutRepo.mode(oldExec.id), 'role');

  await channels.insertIfMissing({ ...makeDefaultCard('@lo_new', 'New'), mode: 'shadow' });
  const sync = new AgentRegistrySync({ agents, channels, loadout: creation });
  const first = await sync.run();
  assert.equal(first.created, 1 + 4, 'the new channel\'s orchestrator and four children');

  const newOrch = (await agents.findTop('orchestrator', 'resource', 'telegram:@lo_new'))!;
  const exec = (await agents.findChild(newOrch.id, 'executor'))!;
  const planner = (await agents.findChild(newOrch.id, 'planner'))!;
  assert.equal(await loadoutRepo.mode(exec.id), 'custom');
  const got = await loadoutRepo.enabledTools(exec.id);
  for (const n of ['fetch_feed', 'web_fetch', 'publish_post', 'skip_slot', 'get_top_posts']) assert.ok(got.includes(n), n);
  assert.ok(!got.includes('lint_post'), 'spec 064 FR-006: publish_post lints itself, so lint_post is not in a new writer\'s tools');
  assert.ok(!got.includes('get_recent_posts') && !got.includes('lint_platform_post') && !got.includes('submit_plan'), 'optional and foreign tools stay out');
  assert.ok(got.includes('get_top_posts'), 'peers called it in a third of their runs');
  assert.deepEqual((await loadoutRepo.rows(exec.id)).map((r) => r.createdBy).filter((x, i, a) => a.indexOf(x) === i), ['creation']);
  assert.ok((await loadoutRepo.enabledTools(planner.id)).includes('submit_plan'));
  assert.equal(await loadoutRepo.mode(newOrch.id), 'custom');

  // the owner changes it; a later sync never touches it, nor the old channel's agents
  await loadoutRepo.setTools(exec.id, ['fetch_feed'], 'owner');
  await sync.run();
  await new AgentRegistrySync({ agents, channels, loadout: creation }).run();
  assert.deepEqual(await loadoutRepo.enabledTools(exec.id), ['fetch_feed']);
  assert.equal(await loadoutRepo.mode(oldExec.id), 'role', 'sync never changes an existing agent\'s loadout');
  assert.deepEqual(await loadoutRepo.rows(oldExec.id), []);
});
