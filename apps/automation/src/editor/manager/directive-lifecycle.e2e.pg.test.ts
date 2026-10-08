/**
 * Spec 025 T7: the directive life cycle end to end on a throwaway Postgres with every migration applied and a
 * scripted LLM driving the real orchestrator run (NetworkRunner → delivered directives in the prompt → the real
 * response tools → afterOrchestration → the real executors):
 *   file → deliver → accept / decline / contest → uphold / accept-refusal / timeout → apply → verify → evaluate,
 * plus pause_resource (approved, applied, owner lift and auto-lift at `until`) and an experiment quota.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { ConflictException } from '@nestjs/common';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm } from '../harness/testing/fakes';
import { PgRunRecorder } from '../harness/run-recorder';
import { SkillLibrary } from '../skills/skill-library';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRuntime } from '../agents/agent-runtime';
import { SkillStore } from '../agents/skill-store';
import { OwnerInbox } from '../agents/owner-inbox';
import { ResourceProfilesRepository } from '../agents/resource-profile';
import { ResourceTime } from '../time/resource-time';
import { NetworkRepository } from '../network/network.repository';
import { NetworkRunner } from '../network/network-runner';
import { networkContext } from '../network/network-context';
import { buildNetworkTools } from '../network/network-tools';
import { PlaybookSchema } from '../network/playbook';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { localDate } from '../roles/time';
import { ResourcePauseService } from '../pauses/resource-pauses';
import { ResourcePausesApi } from '../pauses/resource-pauses.controller';
import { DirectivesRepository } from './directives.repository';
import { ManagerRunner } from './manager-runner';
import { ManagerService } from './manager.service';
import { buildDirectiveTools, fileDirective, type FileDirective } from './directive-tools';
import {
  DirectiveExecution, executionContextOf, experimentExecutor, formatShiftExecutor, frequencyExecutor, pauseResourceExecutor, pauseSeriesExecutor,
  promoVerifier, SqlExperimentQuotas, SqlPlanObserver,
} from './executors';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt025e2e_space';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt025e2e_orch';
const GROUP = 'pgt025e2e group';
const DAY = 86_400_000;
let pool: Pool;
let orchId: string;
let IG: string;
let ruleId: number;

/** The test's clock (the pause auto-lift moves it forward); every service reads it. */
let clock: Date | null = null;
const now = () => clock ?? new Date();

/** The KPI digest the MANAGER and the evaluator read: views/post on the anchor, flagged as an anomaly. */
let views = 500;
const digestOf = () => ({
  generatedAt: now().toISOString(), today: localDate(now(), 'Europe/Kyiv'),
  resources: [{
    ref: TG, title: 'Космос', agent: HANDLE, health: 'ok', anomalies: ['views_per_post'],
    kpis: { views_per_post: { v: views, base: 1000, d: Math.round((views - 1000) / 10), z: -3, anomaly: true } },
  }],
  raw: new Map([[TG, { views_per_post: { value7d: views, stale: false } }]]),
  agents: [], budget: { spentTodayUsd: 0, capUsd: 5 }, directives: { open: [], outcomes: [] }, hash: 'e2e',
}) as any;

const BODY = PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { text: 1, photo: 0.4 }, per_day: { min: 2, max: 5 }, best_hours: [10, 19] },
    { resource_ref: '__IG__', role: `funnel_to:${TG}`, formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, best_hours: [14] },
  ],
});

async function cleanup() {
  await pool.query(`DELETE FROM resource_pauses WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_memory WHERE text LIKE $1`, [`%@${HANDLE} %`]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM content_ideas WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id = 'pgt025e2e-ig'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name = $1`, [GROUP]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', 'independent') RETURNING id`, [GROUP])).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'pgt025e2e_space', 'Космос', true, $2)`, [CH, groupId]);
  IG = `instagram:${(await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id, last_verified_at) VALUES ('instagram', 'pgt025e2e-ig', 'X', 't', 'pgt025e2e_ig', $1, now()) RETURNING id`,
    [groupId])).rows[0].id}`;
  await pool.query(
    `INSERT INTO editor_channels (channel_key, title, mode, formats, posts_per_day_min, posts_per_day_max, plan_hour) VALUES ($1, 'Космос', 'live', '{"text":1,"photo":0.4,"longread":0.3}', 2, 5, 0)`, [CH]);
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: TG, name: 'Kosmos', handle: HANDLE, mode: 'live', createdBy: 'owner' })).id;
  const body = { ...BODY, platforms: BODY.platforms.map((p) => (p.resource_ref === '__IG__' ? { ...p, resource_ref: IG } : p)) };
  await new NetworkRepository(pool).insertPlaybook({ agentId: orchId, status: 'active', brief: null, body, rationale: 'seed', createdBy: 'owner' });
  ruleId = await new EditorMemoryRepository(pool).add(CH, 'rule', 'Не більше 5 постів на день у Telegram — правило власника', null, 'owner');
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

/** The production wiring of spec 025 around one orchestrator; the LLM is scripted per run. */
function stack() {
  const repo = new DirectivesRepository(pool);
  const agents = new AgentsRepository(pool);
  const inbox = new OwnerInbox(pool as any, async () => {});
  const network = new NetworkRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const profiles = new ResourceProfilesRepository(pool);
  const time = new ResourceTime({ card: (k) => channels.get(k), profile: (ref) => profiles.rawProfile(ref), warn: async () => {} });
  const pauses = new ResourcePauseService({ pool, inbox, now });
  const quotas = new SqlExperimentQuotas(pool);
  const xdeps = { network, channels, observer: new SqlPlanObserver(pool) };
  const exec = new DirectiveExecution({
    repo, inbox, agents, now, context: executionContextOf({ repo: network, channels, time, pauses, now }),
    executors: [
      frequencyExecutor(xdeps), formatShiftExecutor(xdeps), pauseSeriesExecutor(xdeps),
      experimentExecutor({ quotas, now }), pauseResourceExecutor({ pauses, now }),
    ],
    verifiers: [promoVerifier(pool, 'cross_promo', now), promoVerifier(pool, 'repost', now)],
    quotas,
  });
  const digest = { build: async () => digestOf(), render: () => '{}', snapshot: async () => 0 };
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents, repo, digest, inbox, env: () => undefined, exec, now,
  });
  const deps = {
    repo, agents, digest, inbox, memory, actions: { propose: async () => ({}) as any }, channelKeyOf: async () => CH, exec, now,
    scopeOf: async () => [TG, IG], usable: async () => true,
  };
  const svc = new ManagerService({ repo, agents, digest, runner });
  const api = new ResourcePausesApi(pauses, now);

  /** One orchestrator run: the scripted answers to the delivered directives, then finish_orchestration. */
  async function orchestrate(calls: Array<{ name: string; args: unknown }>) {
    const llm = new FakeLlm([
      { calls },
      { calls: [{ name: 'finish_orchestration', args: { summary: 'Відповів на директиви й поради менеджера.' } }] },
    ]);
    const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), budget: new FakeBudget(), enabled: () => true });
    const registry = new ToolRegistry([...buildNetworkTools({ repo: network, plans, memory, inbox, now }), ...buildDirectiveTools(deps as any)]);
    const runtime = new AgentRuntime({ agents, store: new SkillStore(pool), fallback: new SkillLibrary(), now });
    const net = new NetworkRunner({
      loop, registry, runtime, memory, repo: network, plans, profiles, env: () => undefined, notify: async () => {}, time, now,
      directives: (orch) => runner.deliver(orch),
      afterOrchestration: (orch) => runner.afterOrchestration(orch, digestOf()).then(() => undefined),
    });
    const res = await net.runOrchestrator((await channels.get(CH))!);
    const system = String(llm.requests[0]?.messages?.find((m: any) => m.role === 'system')?.content ?? '');
    const results = await toolResults(res?.runId ?? null);
    return { res, system, results };
  }

  const file = (i: Omit<FileDirective, 'to' | 'review_in_days'> & { review_in_days?: number }) =>
    fileDirective(deps as any, { to: HANDLE, review_in_days: 7, ...i } as FileDirective, { from: null, runId: null, shadow: false, digest: digestOf() }) as Promise<any>;

  return { repo, agents, network, plans, pauses, quotas, exec, runner, svc, api, orchestrate, file };
}

async function toolResults(runId: string | null): Promise<Record<string, any>> {
  if (!runId) return {};
  const { rows } = await pool.query(`SELECT tool_name, output FROM editor_run_steps WHERE run_id = $1 AND type = 'tool' ORDER BY idx`, [runId]);
  return Object.fromEntries(rows.map((r) => [r.tool_name, r.output]));
}

const inboxOf = async (id: string) => (await pool.query(
  `SELECT kind, severity FROM agent_inbox WHERE ref_type = 'directive' AND ref_id = $1 ORDER BY id`, [id])).rows as Array<{ kind: string; severity: string }>;

const evidence = { views_per_post: { v: 500, base: 1000, d: -50 } };
const expected = { metric: 'views_per_post' as const, direction: 'up' as const, min_change_pct: 10, resource_ref: TG };
const tomorrow = () => localDate(new Date(now().getTime() + DAY), 'Europe/Kyiv');

/** A day plan of the anchor (what the planner wrote): content slots on Telegram unless `ref` says otherwise. */
async function dayPlan(day: string, slots: Array<{ format: string; ref?: string; hints?: string[]; experiment?: boolean }>): Promise<string> {
  await pool.query(`UPDATE editor_plans SET status = 'superseded' WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`, [CH, day]);
  const planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, 'planner') RETURNING id`, [CH, day])).rows[0].id;
  let h = 9;
  for (const s of slots) {
    await pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, resource_ref, source_hints, is_experiment)
       VALUES ($1, $2, ($3::date + make_time($4, 0, 0)) AT TIME ZONE 'Europe/Kyiv', $5, 'pgt025e2e тема', $6, $7, $8)`,
      [planId, CH, day, h, s.format, s.ref ?? null, JSON.stringify(s.hints ?? []), !!s.experiment]);
    h += 2;
  }
  return planId;
}

const reviewNow = (id: string) => pool.query(`UPDATE agent_directives SET review_at = now() - interval '1 minute' WHERE id = $1`, [id]);

test('binding format_shift: filed on an anomaly → delivered → accepted → a playbook version by the directive → the plan follows → verified → evaluated worked', { skip }, async () => {
  const s = stack();
  const filed = await s.file({
    kind: 'format_shift', binding: 'directive', body: 'Більше фото в Telegram: фото тримають перегляди', params: { format: 'photo', weight_delta: 0.2 },
    rationale: 'Перегляди на пост впали на 50% за тиждень, фото-пости тримаються краще за текст', evidence, expected,
  });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  const id = filed.directive.id;
  assert.deepEqual([filed.directive.status, filed.directive.binding, filed.directive.structural], ['new', 'directive', false]);

  const run = await s.orchestrate([{ name: 'accept_directive', args: { id, plan: 'Підніму вагу фото до 0.6 з наступного плану', conflicting_rule_ids: [] } }]);
  assert.equal(run.res?.terminalTool, 'finish_orchestration', run.res?.error ?? '');
  assert.match(run.system, new RegExp(`ДИРЕКТИВА[^\\n]*id ${id}`), 'delivered as a binding directive in the prompt');
  assert.equal(run.results.accept_directive?.ok, true, JSON.stringify(run.results.accept_directive));

  const row = (await s.repo.get(id))!;
  assert.equal(row.status, 'applied', row.execError ?? '');
  assert.ok(row.deliveredAt && row.appliedAt);
  assert.deepEqual([row.change.op, row.change.before, row.change.after, row.change.target], ['format_weight', 0.4, 0.6, 'playbook']);
  assert.equal(row.outcomeDetail?.before?.value, 500, 'the baseline is recorded when it is applied');
  const active = (await s.network.activePlaybook(orchId))!;
  assert.deepEqual([active.createdBy, active.directiveId, active.body.platforms.find((p) => p.resource_ref === TG)!.formats.photo], ['directive', id, 0.6]);

  // No plan yet → nothing to observe; the next plan uses photo → verified.
  await s.runner.housekeeping();
  assert.equal((await s.repo.get(id))!.verifiedAt, null);
  await dayPlan(tomorrow(), [{ format: 'photo' }, { format: 'text' }, { format: 'photo' }]);
  await s.runner.housekeeping();
  const v = (await s.repo.get(id))!;
  assert.ok(v.verifiedAt, JSON.stringify(v.verification));
  assert.deepEqual([v.verification.kind, v.verification.adherence], ['observed', 'followed']);

  // Review date: views/post recovered 500 → 650 (+30 %) → worked.
  views = 650;
  await reviewNow(id);
  await s.runner.housekeeping();
  const e = (await s.repo.get(id))!;
  assert.deepEqual([e.status, e.outcome], ['evaluated', 'worked'], JSON.stringify(e.outcomeDetail));
  views = 500;
});

test('advice: the orchestrator declines it with a data reason → declined, no cooldown and no Inbox entry', { skip }, async () => {
  const s = stack();
  const filed = await s.file({
    kind: 'format_shift', binding: 'advice', body: 'Можна трохи менше фото на користь тексту', params: { format: 'photo', weight_delta: -0.1 },
    rationale: 'Текстові пости минулого тижня мали трохи більше реакцій', evidence, expected,
  });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  const id = filed.directive.id;
  const run = await s.orchestrate([{ name: 'decline_advice', args: { id, reason_kind: 'data', reason: 'Свіжі дані: фото-пости дають +30% переглядів, текст — ні' } }]);
  assert.match(run.system, new RegExp(`порада[^\\n]*id ${id}`), 'delivered as advice');
  assert.equal(run.results.decline_advice?.ok, true, JSON.stringify(run.results.decline_advice));
  const row = (await s.repo.get(id))!;
  assert.deepEqual([row.status, row.reasonKind], ['declined', 'data']);
  assert.deepEqual(await inboxOf(id), []);
  assert.equal(await s.repo.lastRejected(orchId, 'format_shift'), null, 'a declined advice starts no cooldown');
  assert.equal((await s.network.activePlaybook(orchId))!.body.platforms.find((p) => p.resource_ref === TG)!.formats.photo, 0.6, 'nothing applied');
});

test('binding frequency vs an owner rule: contested (checked) → one Inbox card → uphold applies it; accept-refusal starts the cooldown; a contest timeout lets the refusal stand', { skip }, async () => {
  const s = stack();
  const freq = await s.file({
    kind: 'frequency', binding: 'directive', body: 'Публікувати частіше в Telegram: +20% постів на день', params: { resource_ref: TG, change_pct: 20 },
    rationale: 'Перегляди впали, а частота найнижча за місяць — потрібно більше точок контакту', evidence, expected,
  });
  assert.equal(freq.ok, true, JSON.stringify(freq));
  const fmt = await s.file({
    kind: 'format_shift', binding: 'directive', body: 'Ще більше фото в Telegram', params: { format: 'photo', weight_delta: 0.1 },
    rationale: 'Фото після директиви тримають перегляди, варто посилити зсув', evidence, expected,
  });
  assert.equal(fmt.ok, true, JSON.stringify(fmt));
  // A task delivered with the same run (inserted directly: tasks need an escalation to be binding).
  const task = await s.repo.insert({
    fromAgentId: null, toAgentId: orchId, kind: 'task', binding: 'directive', structural: false, body: 'Запусти рубрику питань до читачів',
    params: {}, rationale: 'r', evidence: null, expected: null, reviewAt: new Date(Date.now() + 7 * DAY), status: 'new', shadow: false,
  });
  const reason = 'Правило власника #' + ruleId + ': не більше 5 постів на день у Telegram';
  const run = await s.orchestrate([
    { name: 'contest_directive', args: { id: freq.directive.id, reason_kind: 'owner_rule', reason, rule_ids: [ruleId] } },
    { name: 'contest_directive', args: { id: fmt.directive.id, reason_kind: 'owner_rule', reason: `${reason} і формати каналу`, rule_ids: [ruleId] } },
    { name: 'contest_directive', args: { id: task.id, reason_kind: 'owner_rule', reason: `${reason} — нова рубрика додасть пости`, rule_ids: [ruleId] } },
  ]);
  assert.equal(run.res?.terminalTool, 'finish_orchestration', run.res?.error ?? '');
  for (const id of [freq.directive.id, fmt.directive.id, task.id]) {
    const r = (await s.repo.get(id))!;
    assert.equal(r.status, 'contested', `${r.kind}: ${JSON.stringify(r.verification)}`);
    assert.deepEqual([r.reasonKind, r.verification.contest.verified, r.verification.contest.rule_ids], ['owner_rule', true, [ruleId]]);
    assert.deepEqual(await inboxOf(id), [{ kind: 'directive_contested', severity: 'action' }], 'exactly one owner card');
  }

  // Owner upholds the frequency directive: the executor runs (the owner rule is not re-checked) → 2–5 becomes 2–6.
  const up = await s.svc.ownerDecision(freq.directive.id, 'uphold');
  assert.deepEqual([up.directive.status, up.directive.ownerDecision], ['applied', 'upheld'], up.directive.execError ?? '');
  const active = (await s.network.activePlaybook(orchId))!;
  assert.deepEqual([active.directiveId, active.body.platforms.find((p) => p.resource_ref === TG)!.per_day], [freq.directive.id, { min: 2, max: 6 }]);
  await assert.rejects(s.svc.ownerDecision(freq.directive.id, 'uphold'), (e: any) => e.status === 409 && e.response.error === 'not_contested');

  // Owner sides with the orchestrator on the format shift: rejected, 48 h cooldown on that kind.
  const ref = await s.svc.ownerDecision(fmt.directive.id, 'accept_refusal');
  assert.deepEqual([ref.directive.status, ref.directive.ownerDecision], ['rejected', 'refusal_accepted']);
  const cooled = await s.file({
    kind: 'format_shift', binding: 'directive', body: 'Знову більше фото в Telegram', params: { format: 'photo', weight_delta: 0.1 },
    rationale: 'Перегляди досі нижчі за базу — повторна спроба зсуву формату', evidence, expected,
  });
  assert.equal(cooled.error, 'cooldown');

  // Nobody answers the task's contest for 25 h → the refusal stands.
  await pool.query(`UPDATE agent_directives SET contested_at = now() - interval '25 hours' WHERE id = $1`, [task.id]);
  const hk = await s.runner.housekeeping();
  assert.equal(hk.contestTimedOut, 1);
  const t = (await s.repo.get(task.id))!;
  assert.deepEqual([t.status, t.ownerDecision], ['rejected', 'timeout_dropped']);

  // The upheld frequency is never observed in a plan made after it → at review: inconclusive (not_verified).
  await reviewNow(freq.directive.id);
  await s.runner.housekeeping();
  const f = (await s.repo.get(freq.directive.id))!;
  assert.deepEqual([f.status, f.outcome, f.outcomeDetail?.reason], ['evaluated', 'inconclusive', 'not_verified']);
});

test('pause_resource: owner-approved → accepted → paused (out of the network); owner lift (409 on repeat) → verified; a second pause lifts itself at `until`', { skip }, async () => {
  const s = stack();
  const pauseInput = (days: number) => ({
    kind: 'pause_resource' as const, binding: 'directive' as const, body: `Призупинити Instagram на ${days} дн. — охоплення обвалилось`,
    params: { resource_ref: IG, days, reason: 'охоплення Instagram обвалилось' },
    rationale: 'Instagram втратив 70% охоплення за тиждень, публікації йдуть у порожнечу', evidence, expected,
  });
  const p1 = await s.file(pauseInput(3));
  assert.equal(p1.ok, true, JSON.stringify(p1));
  assert.deepEqual([p1.directive.status, p1.directive.structural], ['awaiting_owner', true]);
  assert.deepEqual(await inboxOf(p1.directive.id), [{ kind: 'directive_structural', severity: 'action' }]);
  await s.svc.decide(p1.directive.id, true);

  const run = await s.orchestrate([{ name: 'accept_directive', args: { id: p1.directive.id, plan: 'Instagram на паузі 3 дні, контент лише в Telegram', conflicting_rule_ids: [] } }]);
  assert.equal(run.results.accept_directive?.ok, true, JSON.stringify(run.results.accept_directive));
  let row = (await s.repo.get(p1.directive.id))!;
  assert.equal(row.status, 'applied', row.execError ?? '');
  assert.deepEqual([row.change.op, row.change.resource_ref, row.change.days], ['pause_resource', IG, 3]);
  assert.equal(await s.pauses.isPaused(IG), true);
  assert.deepEqual((await inboxOf(p1.directive.id)).map((x) => x.kind), ['directive_structural', 'resource_paused']);
  const orch = (await s.agents.get(orchId))!;
  const card = (await new EditorChannelsRepository(pool).get(CH))!;
  const refs = async () => (await networkContext({ repo: s.network, paused: (r) => s.pauses.isPaused(r) }, orch, card))!.resources.map((r) => r.ref);
  assert.deepEqual(await refs(), [TG], 'the paused Instagram leaves the network the agents plan');

  // While paused: no verdict yet. The owner lifts it early; a second lift → 409 not_paused.
  await s.runner.housekeeping();
  assert.equal((await s.repo.get(p1.directive.id))!.verifiedAt, null);
  const lifted = await s.api.lift(IG);
  assert.equal(lifted.pause.liftedBy, 'owner');
  await assert.rejects(s.api.lift(IG), (e: any) => e instanceof ConflictException && (e.getResponse() as any).error === 'not_paused');
  assert.deepEqual((await refs()).sort(), [IG, TG].sort());
  await s.runner.housekeeping();
  row = (await s.repo.get(p1.directive.id))!;
  assert.ok(row.verifiedAt, JSON.stringify(row.verification));
  assert.equal(row.verification.adherence, 'followed');
  await reviewNow(p1.directive.id);
  await s.runner.housekeeping();
  assert.equal((await s.repo.get(p1.directive.id))!.status, 'evaluated');

  // A second pause (1 day) runs out on its own: the tick at `until` stamps it once and posts resource_resumed.
  const p2 = await s.file(pauseInput(1));
  assert.equal(p2.ok, true, JSON.stringify(p2));
  await s.svc.decide(p2.directive.id, true);
  await s.orchestrate([{ name: 'accept_directive', args: { id: p2.directive.id, plan: 'Ще один день паузи для Instagram', conflicting_rule_ids: [] } }]);
  row = (await s.repo.get(p2.directive.id))!;
  assert.equal(row.status, 'applied', row.execError ?? '');
  const until = new Date(row.change.until);
  assert.ok(Math.abs(until.getTime() - (Date.now() + DAY)) < 5 * 60_000, row.change.until);
  try {
    clock = new Date(until.getTime() + 60_000);
    assert.equal(await s.pauses.isPaused(IG), false, 'a pause ends exactly at until');
    const due = await s.pauses.liftDue(clock);
    assert.deepEqual(due.map((p) => [p.resourceRef, p.liftedBy]), [[IG, 'schedule']]);
    assert.deepEqual(await s.pauses.liftDue(clock), [], 'stamped once');
    assert.deepEqual((await inboxOf(p2.directive.id)).map((x) => x.kind).slice(-2), ['resource_paused', 'resource_resumed']);
    await s.runner.housekeeping();
    assert.equal((await s.repo.get(p2.directive.id))!.verification?.adherence, 'followed');
  } finally {
    clock = null;
  }
  await pool.query(`UPDATE agent_directives SET status = 'evaluated' WHERE id = $1`, [p2.directive.id]);
});

test('experiment quota: accepted → open quota (pending until planned) → the directive slot applies it → shadowed → verified', { skip }, async () => {
  const s = stack();
  const filed = await s.file({
    kind: 'experiment', binding: 'directive', body: 'Експеримент: пост-питання до аудиторії замість висновку',
    params: { resource_ref: TG, angle: 'Питання до аудиторії замість висновку', slots: 1, within_days: 3 },
    rationale: 'Перегляди падають; перевіримо, чи питання до читачів повертають реакції', evidence, expected,
  });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  const id = filed.directive.id;
  await s.orchestrate([{ name: 'accept_directive', args: { id, plan: 'Додам слот-питання в найближчий план', conflicting_rule_ids: [] } }]);
  let row = (await s.repo.get(id))!;
  assert.equal(row.status, 'accepted', row.execError ?? '');
  assert.deepEqual([row.change.op, row.change.resource_ref, row.change.slots], ['experiment', TG, 1]);
  const day = tomorrow();
  assert.deepEqual((await s.quotas.open(CH, day, new Date())).map((q) => [q.directiveId, q.remaining]), [[id, 1]]);

  await dayPlan(day, [{ format: 'photo' }, { format: 'text', hints: [`directive:${id}`], experiment: true }]);
  await pool.query(`UPDATE agent_directives SET updated_at = now() - interval '2 hours' WHERE id = $1`, [id]);
  await s.runner.housekeeping();
  row = (await s.repo.get(id))!;
  assert.equal(row.status, 'applied', row.execError ?? '');
  assert.equal(row.verifiedAt, null);
  await pool.query(`UPDATE editor_slots SET status = 'shadowed' WHERE channel_key = $1 AND source_hints ? $2`, [CH, `directive:${id}`]);
  await s.runner.housekeeping();
  row = (await s.repo.get(id))!;
  assert.ok(row.verifiedAt, JSON.stringify(row.verification));
  assert.equal(row.verification.adherence, 'followed');
  assert.deepEqual((await s.repo.list({ toAgentId: orchId, verified: true, kinds: ['experiment'] })).map((x) => x.id), [id]);
});
