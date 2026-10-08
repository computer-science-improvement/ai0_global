/**
 * Spec 025 T2 on a throwaway Postgres with every migration applied: an accepted format_shift becomes an active
 * playbook version written by the directive (created_by 'directive', directive_id, the owner's pending draft
 * kept) with before/after in `change`; re-applying is a no-op; the hourly housekeeping verifies it from the
 * next plan, retries a broken directive and fails it after 3 attempts with one Inbox entry, resumes a paused
 * series on its date; directive_lock refuses a revert through submit_playbook.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../../agents/agents.repository';
import { OwnerInbox } from '../../agents/owner-inbox';
import { NetworkRepository } from '../../network/network.repository';
import { PlaybookSchema } from '../../network/playbook';
import { normalizePlaybook, submitPlaybookVersion } from '../../network/series-edit';
import { networkContext } from '../../network/network-context';
import { EditorChannelsRepository } from '../../repo/editor-channels.repository';
import { localDate } from '../../roles/time';
import { DirectivesRepository } from '../directives.repository';
import { ManagerRunner } from '../manager-runner';
import { DirectiveExecution, executionContextOf, formatShiftExecutor, frequencyExecutor, pauseSeriesExecutor, SqlPlanObserver, type Change } from '.';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt025x_space';
const REF = `telegram:${CH}`;
const HANDLE = 'pgt025x_orch';
let pool: Pool;
let orchId: string;

const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1, photo: 0.4 }, per_day: { min: 2, max: 5 } }],
  series: [{ name: 'Фото дня', cadence: 'daily@10:00', resource_ref: REF, format: 'photo', brief: 'Найкраще фото дня з коротким описом' }],
});

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'X', handle: HANDLE, mode: 'live', createdBy: 'owner' })).id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"text":1,"photo":0.4,"poll":0}')`, [CH]);
  const net = new NetworkRepository(pool);
  await net.insertPlaybook({ agentId: orchId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'owner' });
  // The owner's pending draft must survive a directive's version.
  await net.insertPlaybook({ agentId: orchId, status: 'pending_owner', brief: null, body: { ...BODY, rules: ['Без мемів'] }, rationale: 'owner draft', createdBy: 'orchestrator' });
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
  const deps = { network, channels, observer: new SqlPlanObserver(pool) };
  const exec = new DirectiveExecution({
    repo, inbox, agents, context: executionContextOf({ repo: network, channels }),
    executors: [frequencyExecutor(deps), formatShiftExecutor(deps), pauseSeriesExecutor(deps)],
  });
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents, repo, inbox, env: () => undefined, exec,
    digest: { build: async () => ({ resources: [], raw: new Map() }) as any, render: () => '', snapshot: async () => 0 },
  });
  return { repo, agents, inbox, network, channels, exec, runner, deps };
}

const accepted = (repo: DirectivesRepository, kind: any, params: Record<string, unknown>, binding: 'directive' | 'advice' = 'directive') => repo.insert({
  fromAgentId: null, toAgentId: orchId, kind, binding, structural: false, body: `test ${kind}`, params, rationale: 'r', evidence: null, expected: null,
  reviewAt: new Date(Date.now() + 7 * 86_400_000), status: 'new', shadow: false,
}).then(async (d) => (await repo.update(d.id, { status: 'accepted' }, ['new']))!);

async function plan(slots: Array<{ format: string; series?: string }>, day: string) {
  await pool.query(`UPDATE editor_plans SET status = 'superseded' WHERE channel_key = $1 AND plan_date = $2::date AND status = 'active'`, [CH, day]);
  const { rows } = await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, $2) RETURNING id`, [CH, day]);
  for (const s of slots) {
    await pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, series_name) VALUES ($1, $2, ($3::date + time '12:00') AT TIME ZONE 'Europe/Kyiv', $4, 't', $5)`,
      [rows[0].id, CH, day, s.format, s.series ?? null]);
  }
}

test('accepted format_shift → active version by the directive, change before/after, owner draft kept, re-apply no-op, verified from the next plan', { skip }, async () => {
  const s = setup();
  const dir = await accepted(s.repo, 'format_shift', { format: 'photo', weight_delta: 0.3 });
  const orch = (await s.agents.get(orchId))!;
  const applied = await s.runner.afterOrchestration(orch, null);
  assert.deepEqual(applied.map((x) => x.id), [dir.id]);
  const row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'applied');
  assert.ok(row.appliedAt);
  assert.deepEqual([row.change.before, row.change.after, row.change.target, row.change.noop], [0.4, 0.7, 'playbook', false]);
  const active = (await s.network.activePlaybook(orchId))!;
  assert.equal(active.createdBy, 'directive');
  assert.equal(active.directiveId, dir.id);
  assert.equal(active.body.platforms[0].formats.photo, 0.7);
  assert.equal(row.change.playbook_id, active.id);
  assert.equal((await s.network.pendingPlaybook(orchId))?.rationale, 'owner draft', 'the pending owner draft is kept');

  const versions = (await s.network.playbookHistory(orchId)).length;
  const again = await formatShiftExecutor(s.deps).apply(row.change as Change, row);
  assert.equal(again.noop, true);
  assert.equal((await s.network.playbookHistory(orchId)).length, versions, 're-apply writes no version');

  // Housekeeping: no plan yet → pending; a plan using the format → verified.
  await s.runner.housekeeping();
  assert.equal((await s.repo.get(dir.id))!.verifiedAt, null);
  const tomorrow = localDate(new Date(Date.now() + 86_400_000), 'Europe/Kyiv');
  await plan([{ format: 'photo' }, { format: 'text' }], tomorrow);
  const hk = await s.runner.housekeeping();
  assert.ok(hk.verified >= 1);
  const v = (await s.repo.get(dir.id))!;
  assert.ok(v.verifiedAt);
  assert.equal(v.verification.adherence, 'followed');
  assert.deepEqual((await s.repo.list({ toAgentId: orchId, verified: true })).map((x) => x.id), [dir.id]);
});

test('directive_lock: submit_playbook cannot revert the applied directive before review_at', { skip }, async () => {
  const s = setup();
  const orch = (await s.agents.get(orchId))!;
  const card = (await s.channels.get(CH))!;
  const net = (await networkContext({ repo: s.network }, orch, card))!;
  const active = normalizePlaybook(net.playbook);
  const back = { ...active, platforms: active.platforms.map((p) => ({ ...p, formats: { ...p.formats, photo: 0.4 } })) };
  const deps = { repo: s.network, inbox: s.inbox, directiveLock: (id: string, body: any) => s.exec.lockFor(id, body) };
  const ctx = { runId: 'r', role: 'orchestrator', channelKey: CH, extras: { card } } as any;
  const r: any = await submitPlaybookVersion(deps, net, ctx, back, 'Повертаю вагу фото, як було раніше');
  assert.equal(r.error, 'directive_lock');
  const further = { ...active, platforms: active.platforms.map((p) => ({ ...p, best_hours: [9, 19] })) };
  const ok: any = await submitPlaybookVersion(deps, net, ctx, further, 'Додаю найкращі години для каналу');
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('a directive whose plan cannot apply ends failed after 3 hourly attempts with one Inbox entry', { skip }, async () => {
  const s = setup();
  const dir = await accepted(s.repo, 'format_shift', { format: 'album', weight_delta: 0.2 });
  const orch = (await s.agents.get(orchId))!;
  await s.runner.afterOrchestration(orch, null);
  assert.equal((await s.repo.get(dir.id))!.execAttempts, 1);
  for (let i = 0; i < 3; i++) {
    await pool.query(`UPDATE agent_directives SET updated_at = now() - interval '2 hours' WHERE id = $1`, [dir.id]);
    await s.runner.housekeeping();
  }
  const row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'failed');
  assert.equal(row.execAttempts, 3);
  assert.match(row.execError ?? '', /not_executable/);
  const items = (await pool.query(`SELECT kind, severity FROM agent_inbox WHERE ref_id = $1`, [dir.id])).rows;
  assert.deepEqual(items, [{ kind: 'directive_failed', severity: 'action' }]);
});

test('pause_series: applied → the series is inactive; on resume_on housekeeping writes it active again', { skip }, async () => {
  const s = setup();
  const dir = await accepted(s.repo, 'pause_series', { series: 'Фото дня' });
  await s.runner.afterOrchestration((await s.agents.get(orchId))!, null);
  const row = (await s.repo.get(dir.id))!;
  assert.equal(row.status, 'applied', row.execError ?? '');
  assert.equal((await s.network.activePlaybook(orchId))!.body.series[0].active, false);
  // Verification: the next plan has no slot of the series.
  const day = localDate(new Date(Date.now() + 2 * 86_400_000), 'Europe/Kyiv');
  await plan([{ format: 'text' }], day);
  await s.runner.housekeeping();
  assert.equal((await s.repo.get(dir.id))!.verification.adherence, 'followed');
  // The resume date has come.
  await s.repo.mergeChange(dir.id, { resume_on: localDate(new Date(), 'Europe/Kyiv') });
  const hk = await s.runner.housekeeping();
  assert.equal(hk.resumed, 1);
  const act = (await s.network.activePlaybook(orchId))!;
  assert.equal(act.body.series[0].active, true);
  assert.equal(act.directiveId, dir.id);
  assert.ok((await s.repo.get(dir.id))!.change.resumed_at);
  assert.equal((await s.runner.housekeeping()).resumed, 0, 'resumed once');
});
