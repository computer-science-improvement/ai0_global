/**
 * Spec 025 T3 on a throwaway Postgres with every migration applied: contest_directive checks an owner rule id;
 * a valid contest makes exactly one `directive_contested` Inbox entry; uphold runs the executor (a playbook
 * version by the directive); accept-refusal starts the 48 h cooldown, a declined advice does not; the contest
 * timeout lets the refusal stand; unanswered directives are auto-applied or ignored with Inbox entries.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { NetworkRepository } from '../network/network.repository';
import { PlaybookSchema } from '../network/playbook';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { DirectivesRepository } from './directives.repository';
import { ManagerRunner, AUTO_APPLIED } from './manager-runner';
import { ManagerService } from './manager.service';
import { buildDirectiveTools, fileDirective, type FileDirective } from './directive-tools';
import { DirectiveExecution, executionContextOf, formatShiftExecutor, frequencyExecutor, pauseSeriesExecutor, SqlPlanObserver } from './executors';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt025r_space';
const REF = `telegram:${CH}`;
const HANDLE = 'pgt025r_orch';
let pool: Pool;
let orchId: string;
let ruleId: number;

const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1, photo: 0.4 }, per_day: { min: 2, max: 5 } }],
});

async function cleanup() {
  await pool.query(`DELETE FROM agent_memory WHERE text LIKE $1`, [`%@${HANDLE} %`]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'R', handle: HANDLE, mode: 'live', createdBy: 'owner' })).id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"text":1,"photo":0.4,"poll":0}')`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({ agentId: orchId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'owner' });
  ruleId = await new EditorMemoryRepository(pool).add(CH, 'rule', 'Не більше 5 постів на день — власник', null, 'owner');
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

function setup() {
  const repo = new DirectivesRepository(pool);
  const agents = new AgentsRepository(pool);
  const inbox = new OwnerInbox(pool as any, async () => {});
  const network = new NetworkRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const xdeps = { network, channels, observer: new SqlPlanObserver(pool) };
  const exec = new DirectiveExecution({
    repo, inbox, agents, context: executionContextOf({ repo: network, channels }),
    executors: [frequencyExecutor(xdeps), formatShiftExecutor(xdeps), pauseSeriesExecutor(xdeps)],
  });
  const digest = { build: async () => ({ resources: [], raw: new Map() }) as any, render: () => '{}', snapshot: async () => 0 };
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents, repo, inbox, env: () => undefined, exec, digest,
  });
  const deps = {
    repo, agents, digest, inbox, memory: new EditorMemoryRepository(pool), actions: { propose: async () => ({}) as any },
    channelKeyOf: async () => CH, exec, scopeOf: async () => [REF], usable: async () => true,
  };
  const tools = buildDirectiveTools(deps as any);
  const ctx = { runId: 'r', role: 'orchestrator' as const, channelKey: CH, extras: { orchestrator: null as any } };
  const call = async (name: string, input: any) => {
    ctx.extras.orchestrator = await agents.get(orchId);
    return tools.find((t) => t.name === name)!.execute(input, ctx) as Promise<any>;
  };
  const svc = new ManagerService({ repo, agents, digest, runner });
  return { repo, agents, network, runner, call, svc, deps };
}

/** A delivered directive (the orchestrator has it in its prompt). */
async function delivered(repo: DirectivesRepository, kind: any, params: Record<string, unknown>, binding: 'directive' | 'advice' = 'directive') {
  const d = await repo.insert({
    fromAgentId: null, toAgentId: orchId, kind, binding, structural: false, body: `test ${kind}`, params, rationale: 'r', evidence: null, expected: null,
    reviewAt: new Date(Date.now() + 7 * 86_400_000), status: 'new', shadow: false,
  });
  await repo.markDelivered([d.id]);
  return d;
}

const inboxOf = async (id: string) => (await pool.query(`SELECT kind, severity FROM agent_inbox WHERE ref_type = 'directive' AND ref_id = $1 ORDER BY id`, [id])).rows;

test('contest: unknown rule id → reason_not_verified; owner rule → contested + one Inbox entry; uphold → the executor writes a version; repeat → 409', { skip }, async () => {
  const s = setup();
  const dir = await delivered(s.repo, 'format_shift', { format: 'photo', weight_delta: 0.2 });
  const bad = await s.call('contest_directive', { id: dir.id, reason_kind: 'owner_rule', reason: 'власник обмежив частоту та формати каналу', rule_ids: [ruleId + 1000] });
  assert.equal(bad.error, 'reason_not_verified');
  assert.equal((await s.repo.get(dir.id))!.status, 'new');
  const ok = await s.call('contest_directive', { id: dir.id, reason_kind: 'owner_rule', reason: 'власник обмежив частоту та формати каналу', rule_ids: [ruleId] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const again = await s.call('contest_directive', { id: dir.id, reason_kind: 'owner_rule', reason: 'власник обмежив частоту та формати каналу', rule_ids: [ruleId] });
  assert.equal(again.error, 'not_open');
  const row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'contested');
  assert.ok(row.contestedAt);
  assert.equal(row.reasonKind, 'owner_rule');
  assert.deepEqual([row.verification.contest.verified, row.verification.contest.rule_ids], [true, [ruleId]]);
  assert.deepEqual(await inboxOf(dir.id), [{ kind: 'directive_contested', severity: 'action' }]);
  assert.deepEqual((await s.repo.list({ status: ['contested'], toAgentId: orchId })).map((x) => x.id), [dir.id]);

  const up = await s.svc.ownerDecision(dir.id, 'uphold');
  assert.equal(up.directive.status, 'applied', up.directive.execError ?? '');
  assert.equal(up.directive.ownerDecision, 'upheld');
  const active = (await s.network.activePlaybook(orchId))!;
  assert.deepEqual([active.createdBy, active.directiveId, active.body.platforms[0].formats.photo], ['directive', dir.id, 0.6]);
  await assert.rejects(s.svc.ownerDecision(dir.id, 'uphold'), (e: any) => e.status === 409 && e.response.error === 'not_contested');
  await assert.rejects(s.svc.ownerDecision(dir.id, 'accept_refusal'), (e: any) => e.status === 409);
});

test('accept-refusal starts the cooldown; a declined advice does not (and posts nothing)', { skip }, async () => {
  const s = setup();
  const dir = await delivered(s.repo, 'frequency', { change_pct: 20 });
  assert.equal((await s.call('contest_directive', { id: dir.id, reason_kind: 'owner_rule', reason: 'правило власника: не більше 5 постів на день', rule_ids: [ruleId] })).ok, true);
  const out = await s.svc.ownerDecision(dir.id, 'accept_refusal');
  assert.deepEqual([out.directive.status, out.directive.ownerDecision], ['rejected', 'refusal_accepted']);
  const input: FileDirective = {
    to: HANDLE, kind: 'frequency', binding: 'advice', body: 'Трохи частіше публікувати тексти', params: { change_pct: 20 },
    rationale: 'Перегляди на пост стабільні при 4–5 постах на день', evidence: { views_per_post: 900 },
    expected: { metric: 'views_per_post', direction: 'up', min_change_pct: 5 }, review_in_days: 7,
  };
  const cooled: any = await fileDirective(s.deps as any, input, { from: null, runId: null, shadow: false, digest: { resources: [] } as any });
  assert.equal(cooled.error, 'cooldown');
  const mem = (await pool.query(`SELECT text FROM agent_memory WHERE text LIKE $1`, [`%@${HANDLE} щодо frequency%`])).rows;
  assert.equal(mem.length, 1, 'the MANAGER learns that the owner sided with the orchestrator');

  const adv = await delivered(s.repo, 'format_shift', { format: 'photo', weight_delta: -0.1 }, 'advice');
  assert.equal((await s.call('decline_advice', { id: adv.id, reason_kind: 'data', reason: 'фото тримають перегляди краще за текст' })).ok, true);
  assert.equal((await s.repo.get(adv.id))!.status, 'declined');
  assert.deepEqual(await inboxOf(adv.id), []);
  assert.equal(await s.repo.lastRejected(orchId, 'format_shift'), null, 'declined advice is not a rejection');
  // (the format_shift upheld in the previous test is still open: close it so only the cooldown rule is in play)
  await pool.query(`UPDATE agent_directives SET status = 'evaluated' WHERE to_agent_id = $1 AND kind = 'format_shift' AND status = 'applied'`, [orchId]);
  const again: any = await fileDirective(s.deps as any, { ...input, kind: 'format_shift', params: { format: 'photo', weight_delta: -0.1 }, body: 'Менше фото в каналі' },
    { from: null, runId: null, shadow: false, digest: { resources: [] } as any });
  assert.equal(again.ok, true, JSON.stringify(again));
});

test('contest timeout → rejected (timeout_dropped); unanswered directives: auto-applied with an Inbox entry, a task ignored', { skip }, async () => {
  const s = setup();
  // A fresh contest stays; one older than 24 h → the refusal stands.
  const c = await delivered(s.repo, 'pause_series', { series: 'none' });
  await pool.query(`UPDATE agent_directives SET status = 'contested', contested_at = now() - interval '25 hours' WHERE id = $1`, [c.id]);
  // Unanswered for 25 h: a binding format_shift (has an executor) and a task (has none); advice expires silently.
  const fs = await delivered(s.repo, 'format_shift', { format: 'text', weight_delta: -0.2 });
  const task = await delivered(s.repo, 'task', {});
  const adv = await delivered(s.repo, 'advice', {}, 'advice');
  await pool.query(`UPDATE agent_directives SET delivered_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])`, [[fs.id, task.id, adv.id]]);
  const hk = await s.runner.housekeeping();
  assert.equal(hk.contestTimedOut, 1);
  assert.deepEqual([hk.autoApplied, hk.ignored], [1, 1]);
  const cr = (await s.repo.get(c.id))!;
  assert.deepEqual([cr.status, cr.ownerDecision], ['rejected', 'timeout_dropped']);
  const f = (await s.repo.get(fs.id))!;
  assert.deepEqual([f.status, f.resolution], ['applied', AUTO_APPLIED], f.execError ?? '');
  assert.deepEqual(await inboxOf(fs.id), [{ kind: 'directive_auto_applied', severity: 'info' }]);
  assert.equal((await s.repo.get(task.id))!.status, 'expired');
  assert.deepEqual(await inboxOf(task.id), [{ kind: 'directive_ignored', severity: 'action' }]);
  assert.equal((await s.repo.get(adv.id))!.status, 'expired');
  assert.deepEqual(await inboxOf(adv.id), []);
});
