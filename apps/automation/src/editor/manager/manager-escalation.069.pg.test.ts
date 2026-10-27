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
    now: () => clockNow,
  });
  let clockNow = new Date('2026-10-26T07:30:00Z');
  // The posts run (4 days to 2026-10-25) has a directive filed since it began (the one made in the previous test): only trigger 1 fires.
  assert.equal(await runner.escalate(), 1);
  assert.equal(await runner.escalate(), 0, 'the gate: the same two directives say nothing again');
  // Four days on (past the 3-day repeat window) and still unread: the escalation is open, so it is not told again as «still going».
  await db.pool.query(`UPDATE agent_inbox SET created_at = created_at - interval '4 days' WHERE kind = 'manager_escalation'`);
  clockNow = new Date('2026-10-30T07:30:00Z');
  assert.equal(await runner.escalate(), 0, 'open and unchanged: not posted again');
  clockNow = new Date('2026-10-26T07:30:00Z');
  await db.pool.query(`UPDATE agent_inbox SET created_at = created_at + interval '4 days' WHERE kind = 'manager_escalation'`);
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

test('trigger 2 query leaves out channels the owner stopped: switched off, shadow, paused (for good or for a while), under an active resource pause, plain slots paused by the breaker', { skip }, async () => {
  const agents = new AgentsRepository(db.pool);
  const make = async (handle: string, mode: 'off' | 'shadow' | 'approve' | 'live') =>
    (await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:@${handle}`, name: handle, handle, mode, createdBy: 'owner' })).id;
  const ids = {
    approve: await make('pg069_approve', 'approve'), live: await make('pg069_live2', 'live'), off: await make('pg069_off', 'off'),
    shadow: await make('pg069_shadow', 'shadow'), paused: await make('pg069_paused', 'live'), timed: await make('pg069_timed', 'live'),
    over: await make('pg069_over', 'live'), pausedRes: await make('pg069_pausedres', 'live'), liftedRes: await make('pg069_liftedres', 'live'),
    breaker: await make('pg069_breaker', 'live'), resumed: await make('pg069_resumedbrk', 'live'), seriesOnly: await make('pg069_seriesonly', 'live'),
  };
  await db.pool.query(`UPDATE agents SET status = 'paused' WHERE id = $1`, [ids.paused]);
  await db.pool.query(`UPDATE agents SET paused_until = now() + interval '3 days' WHERE id = $1`, [ids.timed]);
  await db.pool.query(`UPDATE agents SET paused_until = now() - interval '1 day' WHERE id = $1`, [ids.over]);
  await db.pool.query(`INSERT INTO resource_pauses (resource_ref, reason, until) VALUES ('telegram:@pg069_pausedres', 't', now() + interval '2 days')`);
  await db.pool.query(`INSERT INTO resource_pauses (resource_ref, reason, until, lifted_at, lifted_by) VALUES ('telegram:@pg069_liftedres', 't', now() + interval '2 days', now(), 'owner')`);
  // The dead-series breaker (spec 068/060, migration 093) or the owner paused the channel's plain slots: the key is `resource:<orchestrator scope_id>`.
  await db.pool.query(
    `INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak) VALUES ('@pg069_breaker', 'resource:telegram:@pg069_breaker', 'telegram:@pg069_breaker', 'no_material', 'no material', 3)`);
  await db.pool.query(
    `INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak, paused_at, resumed_at, resumed_by)
     VALUES ('@pg069_resumedbrk', 'resource:telegram:@pg069_resumedbrk', 'telegram:@pg069_resumedbrk', 'no_material', 'no material', 3,
             '2026-10-01T10:00:00Z', '2026-10-05T10:00:00Z', 'owner')`);   // over long before the day below: its window (10-17..10-23) is clear
  // A pause on one series only: the channel still plans its other slots, a directive to replace the dead series is a real answer.
  await db.pool.query(
    `INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak) VALUES ('@pg069_seriesonly', 'series:Prompt', 'Prompt', 'no_material', 'no material', 3)`);
  for (const h of ['approve', 'live2', 'off', 'shadow', 'paused', 'timed', 'over', 'pausedres', 'liftedres', 'breaker', 'resumedbrk', 'seriesonly']) {
    await snapshot('2026-10-24', { v: 0, base: 3, d: -100, z: -3, anomaly: true }, `telegram:@pg069_${h}`);
  }
  const handles = (await negativePostsDays(db.pool, '2026-10-24')).map((r) => r.handle).filter((h) => h !== 'pg069_esc').sort();
  assert.deepEqual(handles, ['pg069_approve', 'pg069_liftedres', 'pg069_live2', 'pg069_over', 'pg069_resumedbrk', 'pg069_seriesonly'],
    'an open resource: pause leaves the channel out; a resumed one (the day\'s window clear of it) and a series-only pause do not');
});

test('retireEscalationMemory retires only the system lines of that escalation subject', { skip }, async () => {
  await repo.addMemory(agentId, 'avoid', 'line a', { escalation: 'escalation:x:posts' }, 'system');
  await repo.addMemory(agentId, 'avoid', 'line a2', { escalation: 'escalation:x:posts', days: 6 }, 'system');
  await repo.addMemory(agentId, 'avoid', 'line b', { escalation: 'escalation:y:posts' }, 'system');
  await repo.addMemory(agentId, 'rule', 'owner line', { escalation: 'escalation:x:posts' }, 'owner');
  assert.equal(await repo.retireEscalationMemory(agentId, 'escalation:x:posts'), 2);
  const texts = (await repo.memory(agentId)).map((r) => r.text);
  assert.ok(texts.includes('line b') && texts.includes('owner line'));
  assert.ok(!texts.includes('line a') && !texts.includes('line a2'));
  assert.equal(await repo.retireEscalationMemory(agentId, 'escalation:x:posts'), 0, 'nothing left to retire');
});

test('trigger 2 query: after Resume the days whose 7-day window overlapped the pause stay out; a day whose window began after the resume counts again', { skip }, async () => {
  const REFW = 'telegram:@pg069_resumedwin';
  await new AgentsRepository(db.pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REFW, name: 'Resumed window', handle: 'pg069_resumedwin', mode: 'live', createdBy: 'owner' });
  // The breaker paused the plain slots on 10-10 and the owner pressed Resume on 10-22: twelve days of the posts anomaly in between
  // (nothing was planned), and the days after it, which are still compared with a window of paused days.
  await db.pool.query(
    `INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak, paused_at, resumed_at, resumed_by)
     VALUES ('@pg069_resumedwin', 'resource:telegram:@pg069_resumedwin', 'telegram:@pg069_resumedwin', 'no_material', 'no material', 3,
             '2026-10-10T12:00:00Z', '2026-10-22T12:00:00Z', 'owner')`);
  const anomaly = { v: 0, base: 3, d: -100, z: -3, anomaly: true };
  await snapshot('2026-10-09', anomaly, REFW);                                                    // its window ended the day before the pause began
  for (let d = 11; d <= 22; d++) await snapshot(`2026-10-${String(d)}`, anomaly, REFW);          // the twelve paused days
  for (const d of ['2026-10-23', '2026-10-29', '2026-10-30', '2026-10-31']) await snapshot(d, anomaly, REFW);
  const days = (await negativePostsDays(db.pool, '2026-10-01')).filter((r) => r.handle === 'pg069_resumedwin').map((r) => r.day);
  // 10-11 .. 10-29 had 10-10 .. 10-22 inside their windows (D-7..D-1). 10-30 is the first whose window (10-23..10-29) starts after the resume.
  assert.deepEqual(days, ['2026-10-09', '2026-10-30', '2026-10-31']);

  // The streak as the manager reads it the day after the Resume: nothing to escalate. The same twelve days on a channel that was never paused are a run.
  const REFN = 'telegram:@pg069_nopause';
  await new AgentsRepository(db.pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REFN, name: 'Never paused', handle: 'pg069_nopause', mode: 'live', createdBy: 'owner' });
  for (let d = 11; d <= 22; d++) await snapshot(`2026-10-${String(d)}`, anomaly, REFN);
  const all = (await negativePostsDays(db.pool, '2026-10-01')).filter((r) => r.day <= '2026-10-23');
  assert.deepEqual(postsRuns(all, '2026-10-23').map((r) => [r.handle, r.firstDay, r.days]), [['pg069_nopause', '2026-10-11', 12]], 'no run for the resumed channel right after Resume');
  // Still paused: the open-pause clause leaves every day out as before.
  await db.pool.query(`UPDATE series_pauses SET resumed_at = NULL, resumed_by = NULL WHERE channel_key = '@pg069_resumedwin'`);
  assert.deepEqual((await negativePostsDays(db.pool, '2026-10-01')).filter((r) => r.handle === 'pg069_resumedwin'), []);
});
