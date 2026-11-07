/**
 * Spec 090 FR-002 against a throwaway Postgres: an `awaiting_owner` directive past the timeout becomes `timeout_applied` and runs
 * its executor in the same housekeeping pass, with a decision row; a drop kind expires; the digest fact line counts answers.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { AutonomyDecisionsRepository } from '../autonomy/autonomy-decisions.repository';
import { DirectivesRepository, type DirectiveKind } from './directives.repository';
import { ManagerRunner } from './manager-runner';
import { ownerAnswersOf } from './kpi-digest.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;
let orchId: string;
const env: Record<string, string> = {};

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p090a_directives');
  pool = db.pool;
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@p090a', name: 'P', handle: 'p090a_orch', mode: 'live', createdBy: 'owner' })).id;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

const file = async (repo: DirectivesRepository, kind: DirectiveKind) => {
  const d = await repo.insert({
    fromAgentId: null, toAgentId: orchId, kind, structural: true, body: `test ${kind}`, params: { resource_ref: 'telegram:@p090a' }, rationale: 'r', evidence: null,
    expected: null, reviewAt: null, status: 'awaiting_owner', shadow: false,
  });
  await pool.query(`UPDATE agent_directives SET created_at = now() - interval '13 hours' WHERE id = $1`, [d.id]);
  return d;
};

test('timeout: frequency applies in the same pass (decision row), cross_promo expires; no memory line', { skip }, async () => {
  const repo = new DirectivesRepository(pool);
  const agents = new AgentsRepository(pool);
  const decisions = new AutonomyDecisionsRepository(pool);
  const ran: string[] = [];
  const exec: any = {
    executorFor: () => ({}), execute: async (d: any) => { ran.push(d.id); return repo.markApplied(d.id, {}); },
    retryPending: async () => [], resumeSeries: async () => 0, verifyApplied: async () => 0, closeQuotas: async () => 0, executeAccepted: async () => [],
  };
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents, repo, inbox: new OwnerInbox(pool as any, async () => {}), env: (k) => env[k], exec, decisions,
    digest: { build: async () => ({ resources: [], raw: new Map() }) as any, render: () => '', snapshot: async () => 0 },
  });
  const f = await file(repo, 'frequency');
  const c = await file(repo, 'cross_promo');
  const r = await runner.housekeeping();
  assert.equal(r.timedOut, 2);
  assert.deepEqual(ran, [f.id], 'the executor ran in this pass, not after the 24 h answer window');
  const fr = (await repo.get(f.id))!;
  assert.equal(fr.status, 'applied');
  assert.equal(fr.ownerDecision, 'timeout_applied');
  const cr = (await repo.get(c.id))!;
  assert.deepEqual([cr.status, cr.ownerDecision], ['expired', 'timeout_dropped']);
  const log = await decisions.list();
  assert.deepEqual(log.map((d) => [d.gate, d.refId, d.action, d.channelKey]).sort(), [
    ['directive:cross_promo', c.id, 'dropped', '@p090a'], ['directive:frequency', f.id, 'applied', '@p090a'],
  ].sort());
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_memory`)).rows[0].n, 0);
});

test('owner_answers: counts approved/declined against everything that reached the owner in 14 days', { skip }, async () => {
  const repo = new DirectivesRepository(pool);
  await pool.query(`DELETE FROM agent_directives`);
  const a = await file(repo, 'frequency');
  const b = await file(repo, 'format_shift');
  await file(repo, 'voice_fix');
  await pool.query(`UPDATE agent_directives SET owner_decision = 'approved', status = 'new' WHERE id = $1`, [a.id]);
  await pool.query(`UPDATE agent_directives SET owner_decision = 'timeout_dropped', status = 'expired' WHERE id = $1`, [b.id]);
  const r = await ownerAnswersOf(pool);
  assert.deepEqual([r?.answered, r?.total, r?.line], [1, 3, 'owner answered 1 of 3 structural directives in 14 days']);
});
