/**
 * Spec 069 FR-005 against a throwaway Postgres (its own database, created and dropped here): the two trigger queries over
 * real `agent_directives` and `kpi_snapshots` rows, the escalation notes through the real Inbox gate, the open-escalation
 * query, and the digest's open-directives query that now keeps an evaluated, not-followed row.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { DirectivesRepository } from './directives.repository';
import { filedSince, negativePostsDays, notFollowedGroups, openEscalations, postsRuns } from './escalation';
import { KpiDigestService } from './kpi-digest.service';
import { ManagerRunner } from './manager-runner';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const REF = 'telegram:@pg069_esc';
let db: FreshDb;
let repo: DirectivesRepository;
let agentId: string;
let otherId: string;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'e069');
  repo = new DirectivesRepository(db.pool);
  const agents = new AgentsRepository(db.pool);
  agentId = (await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'Esc', handle: 'pg069_esc', mode: 'live', createdBy: 'owner' })).id;
  otherId = (await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@pg069_other', name: 'Other', handle: 'pg069_other', mode: 'live', createdBy: 'owner' })).id;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

async function directive(toAgentId: string, kind: 'voice_fix' | 'format_mix', o: { adherence?: string | null; status?: string; shadow?: boolean; updatedDaysAgo?: number } = {}) {
  const d = await repo.insert({
    fromAgentId: null, toAgentId, kind, binding: 'advice', structural: false, body: `Порада ${kind} ${Math.random().toString(36).slice(2, 8)}`, params: {}, rationale: 'r', evidence: null,
    expected: null, reviewAt: null, status: 'new', shadow: o.shadow ?? false,
  });
  await db.pool.query(
    `UPDATE agent_directives SET status = $2, verification = $3::jsonb, updated_at = now() - ($4 || ' days')::interval WHERE id = $1`,
    [d.id, o.status ?? 'applied', o.adherence === undefined ? JSON.stringify({ kind: 'observed', adherence: 'not_followed' }) : (o.adherence ? JSON.stringify({ kind: 'observed', adherence: o.adherence }) : null), String(o.updatedDaysAgo ?? 1)]);
  return d.id;
}

test('trigger 1 query: two or more not_followed per agent and kind within 14 days; shadow, old, followed and single ones do not count', { skip }, async () => {
  const a = await directive(agentId, 'voice_fix');
  const b = await directive(agentId, 'voice_fix', { status: 'evaluated' });
  await directive(agentId, 'voice_fix', { adherence: 'followed' });
  await directive(agentId, 'voice_fix', { shadow: true });
  await directive(agentId, 'voice_fix', { updatedDaysAgo: 20 });
  await directive(agentId, 'format_mix');                       // a single one of another kind
  await directive(otherId, 'voice_fix');                        // a single one of another agent
  const groups = await notFollowedGroups(db.pool);
  assert.equal(groups.length, 1);
  assert.deepEqual([groups[0].handle, groups[0].kind, groups[0].ids.length], ['pg069_esc', 'voice_fix', 2]);
  assert.deepEqual([...groups[0].ids].sort(), [a, b].sort());
  assert.equal(groups[0].bodies.length, 2);
  assert.equal(groups[0].agentId, agentId);
});

async function snapshot(day: string, posts: Record<string, unknown>, ref = REF) {
  await db.pool.query(
    `INSERT INTO kpi_snapshots (scope, scope_id, day, metrics) VALUES ('resource', $1, $2::date, $3::jsonb) ON CONFLICT (scope, scope_id, day) DO UPDATE SET metrics = EXCLUDED.metrics`,
    [ref, day, JSON.stringify({ posts })]);
}

test('trigger 2 query: negative posts anomaly days of an agent\'s own resource, and the directives filed since', { skip }, async () => {
  await snapshot('2026-10-22', { v: 1, base: 3, d: -60, z: -3.1, anomaly: true });
  await snapshot('2026-10-23', { v: 1, base: 3, d: -60, z: -2.5, anomaly: true });
  await snapshot('2026-10-24', { v: 1, base: 3, d: -60, z: -2.2, anomaly: true });
  await snapshot('2026-10-25', { v: 1, base: 3, d: -60, z: -2.2, anomaly: true });
  await snapshot('2026-10-21', { v: 5, base: 3, d: 60, z: 2.4, anomaly: true });          // a positive anomaly is not a drop
  await snapshot('2026-10-20', { v: 1, base: 3, d: -10, z: -0.4 });                       // no anomaly flag
  await snapshot('2026-10-25', { v: 1, base: 3, d: -60, z: -2.2, anomaly: true }, 'telegram:@no_agent_for_me');
  const rows = await negativePostsDays(db.pool, '2026-10-16');
  assert.deepEqual(rows.map((r) => r.day), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.ok(rows.every((r) => r.handle === 'pg069_esc' && r.ref === REF), 'only a resource that has its own orchestrator');
  const runs = postsRuns(rows, '2026-10-26');
  assert.deepEqual(runs.map((r) => [r.handle, r.firstDay, r.days]), [['pg069_esc', '2026-10-22', 4]]);

  // Directives filed for the agent since the run began (a shadow one does not count).
  const since = new Date('2026-10-22T00:00:00Z');
  const before = await filedSince(db.pool, agentId, since);
  assert.ok(before >= 0);
  const fresh = await directive(agentId, 'format_mix', { adherence: 'followed' });
  assert.equal(await filedSince(db.pool, agentId, since), before + 1);
  assert.equal(await filedSince(db.pool, agentId, new Date(Date.now() + 86_400_000)), 0);
  assert.ok(fresh);
});

test('escalate() with the real repo and Inbox: one note per problem through the gate, listed as open until it is read', { skip }, async () => {
  const alerts: string[] = [];
  const inbox = new OwnerInbox(db.pool as any, async (t) => { alerts.push(t); });
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => null, get: async () => null, list: async () => [] } as any,
    repo, digest: { build: async () => ({}) as any, render: () => '{}', snapshot: async () => 1 }, inbox, env: () => undefined,
    now: () => new Date('2026-10-26T07:30:00Z'),
  });
  // The posts run (4 days to 2026-10-25) has a directive filed since it began (the one made in the previous test): only trigger 1 fires.
  assert.equal(await runner.escalate(), 1);
  assert.equal(await runner.escalate(), 0, 'the gate: the same two directives say nothing again');
  const { rows } = await db.pool.query(`SELECT kind, severity, subject, parts, ref_type FROM agent_inbox WHERE kind = 'manager_escalation'`);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].kind, rows[0].severity, rows[0].subject, rows[0].ref_type], ['manager_escalation', 'action', 'escalation:pg069_esc:voice_fix', 'escalation']);
  assert.equal(rows[0].parts.length, 2);
  assert.match(alerts.join('\n'), /Менеджер: @pg069_esc не виконує поради/);

  const open = await openEscalations(db.pool, new Date());
  assert.deepEqual(open.map((e) => [e.subject, e.agent, e.kind, e.directive_ids.length]), [['escalation:pg069_esc:voice_fix', 'pg069_esc', 'voice_fix', 2]]);
  await inbox.markRead('all');
  assert.deepEqual(await openEscalations(db.pool, new Date()), [], 'read: no longer open');
  // A note older than 14 days is not open either.
  await db.pool.query(`UPDATE agent_inbox SET read_at = NULL, created_at = now() - interval '15 days' WHERE kind = 'manager_escalation'`);
  assert.deepEqual(await openEscalations(db.pool, new Date()), []);
});

test('the digest keeps an evaluated, not-followed directive of the last 14 days in its open list, and carries the open escalations', { skip }, async () => {
  const evaluated = await directive(agentId, 'format_mix', { status: 'evaluated', updatedDaysAgo: 2 });
  const stale = await directive(agentId, 'format_mix', { status: 'evaluated', updatedDaysAgo: 30 });
  const followed = await directive(agentId, 'format_mix', { status: 'evaluated', adherence: 'followed' });
  await db.pool.query(`UPDATE agent_inbox SET created_at = now(), read_at = NULL WHERE kind = 'manager_escalation'`);
  const svc = new KpiDigestService({ pool: db.pool, catalog: { list: async () => [] } as any, globalCapUsd: 3, now: () => new Date() });
  const dg = await svc.build();
  const ids = new Set(dg.directives.open.map((x) => x.id));
  assert.ok(ids.has(evaluated), 'evaluated and not followed, two days ago');
  assert.ok(!ids.has(stale), 'older than 14 days');
  assert.ok(!ids.has(followed), 'followed advice is not "open"');
  const row = dg.directives.open.find((x) => x.id === evaluated)!;
  assert.deepEqual([row.status, row.adherence], ['evaluated', 'not_followed']);
  assert.deepEqual(dg.escalations?.map((e) => e.subject), ['escalation:pg069_esc:voice_fix']);
  const h = dg.hash;
  await db.pool.query(`UPDATE agent_inbox SET read_at = now() WHERE kind = 'manager_escalation'`);
  const after = await svc.build();
  assert.equal(after.escalations, undefined);
  assert.notEqual(after.hash, h, 'an escalation that is read changes the hash');
});
