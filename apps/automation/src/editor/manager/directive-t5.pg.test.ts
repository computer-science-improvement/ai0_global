/**
 * Spec 025 T5 on a throwaway Postgres with every migration applied: an accepted experiment opens a quota that
 * submit_plan enforces (a Ukrainian error naming the directive), the planned slot makes it applied and the
 * shadowed slot verifies it; an unverified applied directive is evaluated inconclusive (not_verified); a
 * strategy build goes to the owner with directive_id and the owner's approval applies the directive; a task is
 * reported done with a checked reference; promo verification; the digest's compliance block.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { NetworkRepository } from '../network/network.repository';
import { NetworkService } from '../network/network.service';
import { networkContext } from '../network/network-context';
import { PlaybookSchema } from '../network/playbook';
import { submitPlaybookVersion } from '../network/series-edit';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { buildRoleTools } from '../tools/role-tools';
import { localDate } from '../roles/time';
import { DirectivesRepository, type DirectiveKind } from './directives.repository';
import { ManagerRunner } from './manager-runner';
import { buildDirectiveTools } from './directive-tools';
import { complianceOf } from './kpi-digest.service';
import {
  DirectiveExecution, executionContextOf, experimentExecutor, formatShiftExecutor, frequencyExecutor, pauseSeriesExecutor, PlaybookBuildPort,
  promoVerifier, SqlExperimentQuotas, SqlPlanObserver, strategyExecutor, taskRefCheck,
} from './executors';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt025t5_space';
const REF = `telegram:${CH}`;
const HANDLE = 'pgt025t5_orch';
let pool: Pool;
let orchId: string;

async function cleanup() {
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM content_ideas WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'T5', handle: HANDLE, mode: 'live', createdBy: 'owner' })).id;
  await pool.query(
    `INSERT INTO editor_channels (channel_key, mode, formats, posts_per_day_min, posts_per_day_max, min_gap_minutes) VALUES ($1, 'shadow', '{"text":1,"photo":0.4}', 1, 4, 60)`, [CH]);
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
  const plans = new EditorPlansRepository(pool);
  const quotas = new SqlExperimentQuotas(pool);
  const buildPort = new PlaybookBuildPort();
  const xdeps = { network, channels, observer: new SqlPlanObserver(pool) };
  const exec = new DirectiveExecution({
    repo, inbox, agents, context: executionContextOf({ repo: network, channels }),
    executors: [
      frequencyExecutor(xdeps), formatShiftExecutor(xdeps), pauseSeriesExecutor(xdeps),
      experimentExecutor({ quotas }), strategyExecutor({ network, builder: buildPort }),
    ],
    verifiers: [promoVerifier(pool, 'cross_promo'), promoVerifier(pool, 'repost')],
    quotas,
  });
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents, repo, inbox, env: () => undefined, exec,
    digest: { build: async () => ({ resources: [], raw: new Map() }) as any, render: () => '', snapshot: async () => 0 },
  });
  return { repo, agents, inbox, network, channels, plans, quotas, buildPort, exec, runner };
}

const insert = async (repo: DirectivesRepository, kind: DirectiveKind, params: Record<string, unknown>, status: 'new' | 'accepted' = 'accepted', binding: 'directive' | 'advice' = 'directive', body = `test ${kind}`) => {
  const d = await repo.insert({
    fromAgentId: null, toAgentId: orchId, kind, binding, structural: false, body, params, rationale: 'r', evidence: null, expected: null,
    reviewAt: new Date(Date.now() + 7 * 86_400_000), status: 'new', shadow: false,
  });
  await repo.markDelivered([d.id]);
  return status === 'accepted' ? (await repo.update(d.id, { status: 'accepted' }, ['new']))! : d;
};

const idle = (id: string) => pool.query(`UPDATE agent_directives SET updated_at = now() - interval '2 hours' WHERE id = $1`, [id]);

test('experiment: the quota is enforced by submit_plan (Ukrainian error naming the directive), the planned slot applies it, the shadowed slot verifies it', { skip }, async () => {
  const s = setup();
  const dir = await insert(s.repo, 'experiment', { angle: 'Питання до аудиторії замість висновку', slots: 1, within_days: 3 });
  const orch = (await s.agents.get(orchId))!;
  await s.runner.afterOrchestration(orch, null);
  let row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'accepted', row.execError ?? '');
  assert.deepEqual([row.change.op, row.change.resource_ref, row.change.slots], ['experiment', REF, 1]);

  const tomorrow = localDate(new Date(Date.now() + 86_400_000), 'Europe/Kyiv');
  const open = await s.quotas.open(CH, tomorrow, new Date());
  assert.deepEqual(open.map((q) => [q.directiveId, q.remaining]), [[dir.id, 1]]);

  const tools = buildRoleTools({
    pool, plans: s.plans, memory: new EditorMemoryRepository(pool), channels: s.channels,
    publisher: { send: async () => { throw new Error('tests never publish'); } }, recordPublish: () => {},
    experimentQuotas: (k, d, t) => s.quotas.open(k, d, t),
  });
  const submit = tools.find((t) => t.name === 'submit_plan')!;
  const ctx = { runId: 'r', role: 'planner' as const, channelKey: CH, extras: { card: (await s.channels.get(CH))!, planDate: tomorrow } };
  const slot = (time: string, extra: Record<string, unknown> = {}) => ({ time, format: 'photo', topic: 'Тема поста про космос', source_hints: [], is_experiment: false, ...extra });
  const refused: any = await submit.execute({ rationale: 'Два пости на завтра', slots: [slot('10:00'), slot('15:00')] }, ctx);
  assert.equal(refused.error, 'plan_invalid');
  assert.match(refused.details.join('\n'), new RegExp(`директива ${dir.id} \\(експеримент «Питання до аудиторії замість висновку»\\)`));

  const ok: any = await submit.execute({ rationale: 'Два пости і експеримент', slots: [slot('10:00'), slot('15:00', { directive_id: dir.id, topic: 'Що б ви запитали в астронавта?' })] }, ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const { rows: exp } = await pool.query(`SELECT is_experiment, source_hints FROM editor_slots WHERE channel_key = $1 AND source_hints ? $2`, [CH, `directive:${dir.id}`]);
  assert.deepEqual(exp.map((x) => x.is_experiment), [true]);
  assert.deepEqual(await s.quotas.open(CH, localDate(new Date(Date.now() + 2 * 86_400_000), 'Europe/Kyiv'), new Date()), [], 'filled → closed for the next days');
  assert.equal((await s.quotas.open(CH, tomorrow, new Date())).length, 1, 'a re-plan of the same day must include it again');

  await idle(dir.id);
  await s.runner.housekeeping();
  row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'applied', row.execError ?? '');
  assert.equal(row.verifiedAt, null);
  await pool.query(`UPDATE editor_slots SET status = 'shadowed' WHERE channel_key = $1 AND source_hints ? $2`, [CH, `directive:${dir.id}`]);
  await s.runner.housekeeping();
  row = (await s.repo.get(dir.id))!;
  assert.ok(row.verifiedAt);
  assert.equal(row.verification.adherence, 'followed');
});

test('an experiment quota unfilled at its deadline → failed with an Inbox entry', { skip }, async () => {
  const s = setup();
  const dir = await insert(s.repo, 'experiment', { angle: 'Карусель з фактами замість тексту', slots: 2, within_days: 1 });
  await s.runner.afterOrchestration((await s.agents.get(orchId))!, null);
  await pool.query(`UPDATE agent_directives SET change = jsonb_set(change, '{deadline}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`, [dir.id]);
  const hk = await s.runner.housekeeping();
  assert.ok(hk.failed >= 1);
  const row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'failed');
  assert.match(row.execError ?? '', /0\/2 slot/);
  assert.deepEqual((await pool.query(`SELECT kind, severity FROM agent_inbox WHERE ref_id = $1`, [dir.id])).rows, [{ kind: 'directive_failed', severity: 'action' }]);
});

test('an unverified applied directive is evaluated inconclusive (not_verified) with its adherence', { skip }, async () => {
  const s = setup();
  const dir = await insert(s.repo, 'pause_resource', { resource_ref: REF, days: 3 });
  await s.runner.afterOrchestration((await s.agents.get(orchId))!, null);
  assert.equal((await s.repo.get(dir.id))!.verification.kind, 'unverified');
  await pool.query(`UPDATE agent_directives SET review_at = now() - interval '1 minute' WHERE id = $1`, [dir.id]);
  await s.runner.evaluate();
  const e = (await s.repo.get(dir.id))!;
  assert.deepEqual([e.status, e.outcome, e.outcomeDetail.reason], ['evaluated', 'inconclusive', 'not_verified']);
  assert.ok('adherence' in e.outcomeDetail);
});

test('task: report_directive_done checks the reference (owner, created after delivery) → applied and verified', { skip }, async () => {
  const s = setup();
  const net = new NetworkRepository(pool);
  const old = await net.addIdea({ agentId: orchId, title: 'Стара ідея', sources: ['https://e.example/a'], variants: [], origin: 'orchestrator', expiresAt: new Date(Date.now() + 86_400_000) });
  await pool.query(`UPDATE content_ideas SET created_at = now() - interval '1 hour' WHERE id = $1`, [old.id]);
  const task = await insert(s.repo, 'task', {}, 'accepted', 'directive', 'Додай ідею про запуск Artemis');
  const fresh = await net.addIdea({ agentId: orchId, title: 'Artemis II', sources: ['https://e.example/b'], variants: [], origin: 'orchestrator', expiresAt: new Date(Date.now() + 86_400_000) });
  const tools = buildDirectiveTools({
    repo: s.repo, agents: s.agents, digest: {} as any, inbox: s.inbox, memory: new EditorMemoryRepository(pool), actions: {} as any,
    channelKeyOf: async () => CH, taskRef: taskRefCheck(pool),
  });
  const ctx = { runId: 'r', role: 'orchestrator' as const, channelKey: CH, extras: { orchestrator: await s.agents.get(orchId) } };
  const report = (input: any) => tools.find((t) => t.name === 'report_directive_done')!.execute(input, ctx) as Promise<any>;
  assert.equal((await report({ id: task.id, ref_type: 'idea', ref_id: old.id })).error, 'ref_too_old');
  assert.equal((await report({ id: task.id, ref_type: 'playbook', ref_id: fresh.id })).error, 'ref_not_found');
  // Housekeeping does not touch a task waiting for its report.
  await idle(task.id);
  await s.runner.housekeeping();
  assert.equal((await s.repo.get(task.id))!.status, 'accepted');
  const done = await report({ id: task.id, ref_type: 'idea', ref_id: fresh.id });
  assert.equal(done.ok, true, JSON.stringify(done));
  const row = (await s.repo.get(task.id))!;
  assert.equal(row.status, 'applied');
  assert.ok(row.verifiedAt);
  assert.deepEqual([row.verification.kind, row.verification.ref_id], ['reported', fresh.id]);
});

test('promo: a cross_promo applied by PromoPlanner is verified once its promo slot is shadowed', { skip }, async () => {
  const s = setup();
  const dir = await insert(s.repo, 'cross_promo', { source_ref: REF, target_ref: 'telegram:@other' });
  await s.repo.update(dir.id, { status: 'applied', appliedAt: new Date() }, ['accepted']);
  const { rows } = await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date + 5) RETURNING id`, [CH]);
  const slot = (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, promo) VALUES ($1, $2, now() + interval '5 days', 'reserved', 'text', 'Promo', $3) RETURNING id`,
    [rows[0].id, CH, JSON.stringify({ kind: 'cross_promo', directive_id: dir.id })])).rows[0].id;
  await s.exec.verifyApplied();
  assert.equal((await s.repo.get(dir.id))!.verifiedAt, null, 'planned → pending');
  await pool.query(`UPDATE editor_slots SET status = 'shadowed' WHERE id = $1`, [slot]);
  await s.exec.verifyApplied();
  const v = (await s.repo.get(dir.id))!;
  assert.ok(v.verifiedAt);
  assert.equal(v.verification.adherence, 'followed');
});

test('strategy: the build writes a pending_owner version with directive_id; the owner approving it applies the directive', { skip }, async () => {
  const s = setup();
  const BODY = PlaybookSchema.parse({ platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1, photo: 0.5 }, per_day: { min: 1, max: 4 } }] });
  // The build is an LLM run in production; here it submits a fixed body through the orchestrator's submit path.
  s.buildPort.bind(async (id, brief, directiveId) => {
    const orch = (await s.agents.get(id))!;
    const card = (await s.channels.get(CH))!;
    const net = (await networkContext({ repo: s.network }, orch, card))!;
    const r = await submitPlaybookVersion({ repo: s.network, inbox: s.inbox }, net, { runId: 'r', role: 'orchestrator', channelKey: CH, extras: { card, brief, directiveId } } as any, BODY, `Стратегія: ${brief}`);
    assert.equal((r as any).status, 'pending_owner', JSON.stringify(r));
  });
  const dir = await insert(s.repo, 'strategy', {}, 'accepted', 'directive', 'Зробити канал про фото дня з короткими підписами');
  await s.runner.afterOrchestration((await s.agents.get(orchId))!, null);
  let row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'accepted', row.execError ?? '');
  const pending = (await s.network.pendingPlaybook(orchId))!;
  assert.deepEqual([pending.directiveId, row.change.playbook_id], [dir.id, pending.id]);

  const svc = new NetworkService({
    pool, agents: s.agents, repo: s.network, inbox: s.inbox, card: (k) => s.channels.get(k), rebuild: async () => null,
    onPlaybookDecided: (pb, approve) => s.exec.onPlaybookDecided(pb, approve),
  });
  await svc.decide(pending.id, true);
  row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'applied', row.execError ?? '');
  assert.ok(row.change.activated_at);
  assert.equal((await s.network.activePlaybook(orchId))!.directiveId, dir.id);
});

test('digest compliance: advice followed / declined with the last reasons, contested and auto-applied per orchestrator', { skip }, async () => {
  const s = setup();
  const declined = await insert(s.repo, 'format_shift', {}, 'new', 'advice');
  await s.repo.update(declined.id, { status: 'declined', resolution: 'фото тримають перегляди краще', reasonKind: 'data' }, ['new']);
  const followed = await insert(s.repo, 'advice', {}, 'accepted', 'advice');
  assert.equal(followed.status, 'accepted');
  const contested = await insert(s.repo, 'frequency', { change_pct: 20 }, 'new');
  await s.repo.contest(contested.id, { reason: 'правило власника про частоту', reasonKind: 'owner_rule', check: { verified: true } });
  const auto = await insert(s.repo, 'format_shift', { format: 'text', weight_delta: -0.1 }, 'new');
  await s.repo.update(auto.id, { status: 'accepted', resolution: 'auto-applied: no response' }, ['new']);
  const row = (await complianceOf(pool)).find((r) => r.agent === HANDLE)!;
  assert.ok(row, 'a compliance row for the orchestrator');
  assert.equal(row.advice_declined, 1);
  assert.ok(row.advice_followed >= 1);
  assert.deepEqual(row.decline_reasons, [{ kind: 'data', reason: 'фото тримають перегляди краще' }]);
  assert.equal(row.contested, 1);
  assert.equal(row.auto_applied, 1);
});
