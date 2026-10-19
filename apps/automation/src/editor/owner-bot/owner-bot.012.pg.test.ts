/**
 * Spec 012 T1 against a throwaway Postgres: migration 085 (idempotent), the card repository (once per item, send order,
 * attempts, settle once, requeue, the report claim) and the sources' queries (a post's card only once its batch alert
 * went out; directives, contested ones, inbox notes). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { OwnerCardsRepository } from './owner-cards.repository';
import { cardSources, type SourceDeps } from './card-sources';
import { OwnerReports, channelLines } from './owner-reports';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '085_owner_cards.sql'), 'utf8');
const CH = '@pgtest_owner_012';
const HANDLE = 'pgtest_owner_012';
let pool: Pool;
let repo: OwnerCardsRepository;

async function cleanup() {
  await pool.query(`DELETE FROM owner_cards WHERE ref_id LIKE 'pg012%' OR kind = 'pg012'`);
  await pool.query(`DELETE FROM owner_reports WHERE period LIKE 'pg012%'`);
  await pool.query(`DELETE FROM approval_alerts WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_inbox WHERE kind = 'pg012'`);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM channel_stats_snapshots WHERE channel_id = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(MIGRATION);
  await cleanup();
  repo = new OwnerCardsRepository(pool);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('085 applies again; an unknown status is refused', { skip }, async () => {
  await pool.query(MIGRATION);
  await assert.rejects(pool.query(`INSERT INTO owner_cards (kind, ref_id, title, status) VALUES ('pg012', 'pg012-x', 't', 'weird')`));
});

test('cards: once per item, critical first, five attempts, settled once, requeued from failed', { skip }, async () => {
  const a = await repo.insert({ kind: 'pg012', refId: 'pg012-a', title: 'A', buttons: [{ key: 'ok', label: 'OK' }] });
  assert.ok(a);
  assert.equal(await repo.insert({ kind: 'pg012', refId: 'pg012-a', title: 'again', buttons: [] }), null);
  const b = (await repo.insert({ kind: 'pg012', refId: 'pg012-b', title: 'B', critical: true, buttons: [] }))!;
  const q = (await repo.queued(10)).filter((c) => c.kind === 'pg012');
  assert.deepEqual(q.map((c) => c.refId), ['pg012-b', 'pg012-a']);
  assert.deepEqual(q[1].buttons, [{ key: 'ok', label: 'OK' }]);

  const before = new Date(Date.now() - 1000);
  await repo.markSent(b.id, '42', 555);
  const sent = (await repo.get(b.id))!;
  assert.equal(sent.status, 'open');
  assert.equal(sent.messageId, 555);
  assert.ok((await repo.sentSince(before)) >= 1);

  for (let i = 0; i < 5; i++) await repo.markAttempt(a!.id, `boom ${i}`);
  const failed = (await repo.get(a!.id))!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, 'boom 4');
  assert.equal((await repo.requeue(a!.id))!.status, 'queued');
  assert.equal(await repo.requeue(a!.id), null, 'only failed or closed cards');

  assert.equal((await repo.resolve(b.id, 'done', '✅', 'telegram:42'))!.status, 'done');
  assert.equal(await repo.resolve(b.id, 'closed', 'late', null), null);
  assert.deepEqual((await repo.byRefs('pg012', ['pg012-a', 'pg012-b', 'nope'])).map((c) => c.refId).sort(), ['pg012-a', 'pg012-b']);
  await repo.markCritical(a!.id);
  assert.equal((await repo.get(a!.id))!.critical, true);
  const counts = await repo.counts(before);
  assert.ok(counts.queued >= 1 && counts.sentToday >= 1);
});

test('reports are claimed once per period', { skip }, async () => {
  assert.equal(await repo.claimReport('daily', 'pg012-2026-10-19'), true);
  assert.equal(await repo.claimReport('daily', 'pg012-2026-10-19'), false);
  await repo.releaseReport('daily', 'pg012-2026-10-19');
  assert.equal(await repo.claimReport('daily', 'pg012-2026-10-19'), true);
  assert.ok((await repo.lastReports()).daily instanceof Date);
});

test('sources: a post waits for a card only after its batch alert; directives, contested ones and inbox notes', { skip }, async () => {
  await pool.query(`INSERT INTO editor_channels (channel_key, title) VALUES ($1, 'PG Owner')`, [CH]);
  const plan = async (date: string) => (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, $2) RETURNING id`, [CH, date])).rows[0].id;
  const p1 = await plan('2026-10-19');
  const p2 = await plan('2026-10-20');
  const slot = async (planId: string, at: string) => (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, rendered_preview)
     VALUES ($1, $2, $3, 'text', 'Тема', 'awaiting_approval', 'Текст поста') RETURNING id`, [planId, CH, at])).rows[0].id;
  const s1 = await slot(p1, '2026-10-19T10:00:00Z');
  await slot(p2, '2026-10-20T10:00:00Z');
  await pool.query(`INSERT INTO approval_alerts (channel_key, batch_date, posts) VALUES ($1, '2026-10-19', 1)`, [CH]);

  const agent = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle) VALUES ('orchestrator', 'resource', $1, 'PG', $2) RETURNING id`, [`telegram:${CH}`, HANDLE])).rows[0].id;
  const dir = async (status: string) => (await pool.query(
    `INSERT INTO agent_directives (to_agent_id, kind, body, rationale, status, contested_at, resolution)
     VALUES ($1, 'advice', 'Тіло', 'Чому', $2, CASE WHEN $2 = 'contested' THEN now() END, CASE WHEN $2 = 'contested' THEN 'Ні' END) RETURNING id`,
    [agent, status])).rows[0].id;
  const d1 = await dir('awaiting_owner');
  const d2 = await dir('contested');
  await pool.query(
    `INSERT INTO agent_inbox (kind, title, severity, ref_type, ref_id) VALUES
       ('pg012', 'needs you', 'action', 'resource', 'x'), ('pg012', 'fyi', 'info', NULL, NULL),
       ('pg012', 'directive note', 'action', 'directive', $1)`, [d1]);

  const none = async () => ({}) as any;
  const deps: SourceDeps = {
    pool, approvals: { approve: async () => ({ movedTo: null }), reject: none }, directives: { decide: none, ownerDecision: none },
    actions: { apply: none, discard: none }, steering: { activate: none, discard: none },
    setup: { apply: async () => ({ applied: [], failed: null, changedSinceAnalysis: [] }), discard: none },
    playbooks: { decide: none }, inbox: { markRead: async () => 0 }, setupSections: ['schedule'],
  };
  const byKind = new Map(cardSources(deps).map((s) => [s.kind, s]));
  const now = new Date('2026-10-19T09:00:00Z');

  const posts = (await byKind.get('approval')!.waiting(now)).filter((i) => i.title.startsWith('PG Owner'));
  assert.deepEqual(posts.map((p) => p.refId), [s1]);
  assert.equal(posts[0].critical, true);
  assert.equal(posts[0].body, 'Текст поста');
  await pool.query(`UPDATE editor_slots SET status = 'expired' WHERE id = $1`, [s1]);
  assert.deepEqual([...await byKind.get('approval')!.expired!([s1, 'not-a-uuid'])], [s1]);

  const dirs = (await byKind.get('directive')!.waiting(now)).filter((i) => i.refId === d1);
  assert.equal(dirs[0].title, `@${HANDLE} · advice`);
  const cont = (await byKind.get('contested')!.waiting(now)).filter((i) => i.refId === `${d2}:contested`);
  assert.equal(cont.length, 1);
  await pool.query(`UPDATE agent_directives SET status = 'expired' WHERE id = $1`, [d2]);
  assert.deepEqual([...await byKind.get('contested')!.expired!([`${d2}:contested`])], [`${d2}:contested`]);

  const notes = (await byKind.get('inbox')!.waiting(now)).filter((i) => ['needs you', 'fyi', 'directive note'].includes(i.title));
  assert.deepEqual(notes.map((n) => n.title), ['needs you']);

  // The other sources' queries run.
  for (const k of ['action', 'steering', 'setup', 'playbook']) assert.ok(Array.isArray(await byKind.get(k)!.waiting(now)), k);
});

test('daily summary data: the Kyiv day, per-channel counts and the main skip reason, subscriber change', { skip }, async () => {
  const r = new OwnerReports({
    pool, repo, env: () => undefined, budgets: async () => ({ rows: [] }), health: async () => { throw new Error('n/a'); }, waiting: async () => [],
  });
  const { from, to } = await r.dayBounds(new Date('2026-10-19T18:00:00Z'));
  assert.equal(from.toISOString(), '2026-10-18T21:00:00.000Z');
  assert.equal(to.toISOString(), '2026-10-19T21:00:00.000Z');

  await pool.query(`INSERT INTO editor_channels (channel_key, title) VALUES ($1, 'PG Owner') ON CONFLICT DO NOTHING`, [CH]);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, '2026-10-21') RETURNING id`, [CH])).rows[0].id;
  const slot = (status: string, at: string, error: string | null) => pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, error) VALUES ($1, $2, $3, 'text', 't', $4, $5)`,
    [plan, CH, at, status, error]);
  await slot('published', '2026-10-21T08:00:00Z', null);
  await slot('skipped', '2026-10-21T09:00:00Z', 'daily_cap_reached');
  await slot('skipped', '2026-10-21T10:00:00Z', 'daily_cap_reached');
  await slot('skipped', '2026-10-21T11:00:00Z', 'critic_rejected: weak');
  await slot('skipped', '2026-10-21T12:00:00Z', 'superseded by a new plan');
  await slot('failed', '2026-10-21T13:00:00Z', 'boom');
  await slot('published', '2026-10-22T08:00:00Z', null); // the next day
  await pool.query(`INSERT INTO channel_stats_snapshots (channel_id, captured_at, subscribers) VALUES ($1, '2026-10-20T20:00:00Z', 100), ($1, '2026-10-21T15:00:00Z', 112)`, [CH]);

  const lines = (await channelLines(pool, new Date('2026-10-20T21:00:00Z'), new Date('2026-10-21T21:00:00Z'))).filter((l) => l.ref === `telegram:${CH}`);
  assert.equal(lines.length, 1);
  const { awaiting: _a, ...l } = lines[0];
  assert.deepEqual(l, { ref: `telegram:${CH}`, title: 'PG Owner', published: 1, skipped: 3, skipWhy: 'ліміти', failed: 1, subs: 12 });
});
