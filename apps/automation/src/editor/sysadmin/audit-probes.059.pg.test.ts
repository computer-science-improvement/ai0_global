/**
 * Spec 059 T4 against a throwaway Postgres (its own database): the audit's probe facts — versions stuck in `probing`
 * and the probe's rejections per agent — read from skill_versions, and the checks over them. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AuditQueries } from './audit-queries';
import { runChecks } from './checks';
import { emptyFacts } from './audit.types';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const NOW = new Date('2030-05-06T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let db: ProbeDb;
let pool: Pool;
let q: AuditQueries;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'auditprobes');
  pool = db.pool;
  const agents = new AgentsRepository(pool);
  const a = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@ap_a', name: 'A', handle: 'ap_a', createdBy: 'owner' });
  const b = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@ap_b', name: 'B', handle: 'ap_b', createdBy: 'owner' });
  const skill = async (agentId: string, name: string) =>
    (await pool.query(`INSERT INTO skills (name, scope, agent_id, description, applies_to, body, created_by) VALUES ($1, 'agent', $2, 'Description of the skill', '{executor}', 'Body of the skill text.', 'agent') RETURNING id`, [name, agentId])).rows[0].id as string;
  const ver = (skillId: string, version: number, outcome: string, at: Date) =>
    pool.query(`INSERT INTO skill_versions (skill_id, version, body, description, author, outcome, created_at) VALUES ($1, $2, 'b', 'd', 'agent', $3, $4)`, [skillId, version, outcome, at]);

  const s1 = await skill(a.id, 'hooks-a');
  const s2 = await skill(a.id, 'leads-a');
  const s3 = await skill(b.id, 'hooks-b');
  await ver(s1, 1, 'pending', daysAgo(40));
  await ver(s1, 2, 'rejected', daysAgo(10));
  await ver(s1, 3, 'rejected', daysAgo(8));
  await ver(s2, 1, 'pending', daysAgo(40));
  await ver(s2, 2, 'rejected', daysAgo(2));
  await ver(s2, 3, 'probing', daysAgo(5));      // stuck
  await ver(s3, 1, 'pending', daysAgo(40));
  await ver(s3, 2, 'rejected', daysAgo(3));
  await ver(s3, 3, 'rejected', daysAgo(45));     // outside the 30-day window
  await ver(s3, 4, 'probing', daysAgo(1));       // waiting, not stuck yet
  q = new AuditQueries({ pool, agents: agents as any, skills: {} as any, tools: () => new Set(), ruleLint: async () => [], conflicts: async () => [], playbook: async () => null, now: () => NOW });
});
after(async () => { if (db) await db.drop(); });

test('probe facts: edits waiting past 3 days, and rejections per agent in the 30-day window', { skip }, async () => {
  const p = await q.probes(NOW);
  assert.deepEqual(p.stuck.map((s) => [s.name, s.agent, s.version]), [['leads-a', 'ap_a', 3]]);
  assert.deepEqual(p.rejects.map((r) => [r.agent, r.count, r.skills]), [['ap_a', 3, ['hooks-a', 'leads-a']], ['ap_b', 1, ['hooks-b']]]);
});

test('the checks flag the stuck edit and the agent with three rejections, nobody else', { skip }, async () => {
  const out = runChecks({ ...emptyFacts(NOW), probes: await q.probes(NOW) }).filter((x) => x.check.startsWith('skill_probe'));
  assert.deepEqual(out.map((x) => [x.check, x.subject.label]).sort(), [['skill_probe_rejects', '@ap_a'], ['skill_probe_stuck', 'leads-a']]);
});
