/**
 * Spec 054 T1 against a throwaway Postgres (its own database): migration 087 (idempotent, checks), the loadout
 * repository (set / init / reset, sorted enabled names, rows kept as disabled) and the service on top of it.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { PgRunRecorder } from '../harness/run-recorder';
import { LoadoutRepository } from './loadout.repository';
import { LoadoutService, NO_TOOL } from './loadout.service';
import { createLoadoutDb, type LoadoutDb } from './testing/loadout-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '087_agent_loadout.sql'), 'utf8');

let db: LoadoutDb;
let pool: Pool;
let repo: LoadoutRepository;
let agentId: string;

before(async () => {
  if (!url) return;
  db = await createLoadoutDb(url, 'loadout');
  pool = db.pool;
  repo = new LoadoutRepository(pool);
  const a = await new AgentsRepository(pool).insert({
    kind: 'executor', scope: 'resource', scopeId: 'telegram:@lo_pg', name: 'Exec', handle: 'lo_pg_exec', createdBy: 'sync',
  });
  agentId = a.id;
});
after(async () => { if (db) await db.drop(); });

test('087 applies again; an existing agent keeps mode role; an unknown mode or author is refused', { skip }, async () => {
  await pool.query(MIGRATION);
  assert.equal(await repo.mode(agentId), 'role');
  await assert.rejects(pool.query(`UPDATE agents SET loadout_mode = 'weird' WHERE id = $1`, [agentId]));
  await assert.rejects(pool.query(`INSERT INTO agent_tools (agent_id, tool_name, created_by) VALUES ($1, 'x', 'someone')`, [agentId]));
});

test('role mode: no allowlist', { skip }, async () => {
  const svc = new LoadoutService({ repo });
  assert.equal(await svc.toolsAllow(agentId), null);
});

test('initTools writes a custom loadout once; a second init never rewrites it', { skip }, async () => {
  assert.equal(await repo.initTools(agentId, ['read_b', 'read_a'], 'creation'), true);
  assert.equal(await repo.mode(agentId), 'custom');
  assert.deepEqual(await repo.enabledTools(agentId), ['read_a', 'read_b'], 'sorted');
  assert.equal(await repo.initTools(agentId, ['other'], 'creation'), false);
  assert.deepEqual(await repo.enabledTools(agentId), ['read_a', 'read_b']);
  assert.deepEqual((await repo.rows(agentId)).map((r) => r.createdBy), ['creation', 'creation']);
});

test('setTools replaces the set; dropped rows stay disabled; the author of an enabled row is kept', { skip }, async () => {
  await repo.setTools(agentId, ['read_b', 'act_c'], 'owner');
  assert.deepEqual(await repo.enabledTools(agentId), ['act_c', 'read_b']);
  const rows = await repo.rows(agentId);
  assert.deepEqual(rows.map((r) => [r.toolName, r.enabled, r.createdBy]), [['act_c', true, 'owner'], ['read_a', false, 'creation'], ['read_b', true, 'creation']]);
  // switched back on by a suggestion: the row is the recommender's again
  await repo.setTools(agentId, ['read_a', 'read_b', 'act_c'], 'recommend');
  assert.deepEqual((await repo.rows(agentId)).map((r) => [r.toolName, r.createdBy]), [['act_c', 'owner'], ['read_a', 'recommend'], ['read_b', 'creation']]);
});

test('the service: custom → the enabled names; nothing enabled → the none-marker', { skip }, async () => {
  const svc = new LoadoutService({ repo });
  assert.deepEqual(await svc.toolsAllow(agentId), ['act_c', 'read_a', 'read_b']);
  await repo.setTools(agentId, [], 'owner');
  assert.deepEqual(await svc.toolsAllow(agentId), [NO_TOOL]);
});

test('reset returns to the role default and clears the rows', { skip }, async () => {
  await repo.reset(agentId);
  assert.equal(await repo.mode(agentId), 'role');
  assert.deepEqual(await repo.rows(agentId), []);
  assert.equal(await new LoadoutService({ repo }).toolsAllow(agentId), null);
});

test('deleting an agent removes its loadout rows', { skip }, async () => {
  const b = await new AgentsRepository(pool).insert({
    kind: 'planner', scope: 'resource', scopeId: 'telegram:@lo_pg2', name: 'Plan', handle: 'lo_pg_plan', createdBy: 'sync',
  });
  await repo.setTools(b.id, ['x'], 'owner');
  await pool.query(`DELETE FROM agents WHERE id = $1`, [b.id]);
  assert.deepEqual(await repo.rows(b.id), []);
});

test('a run records the tools offered to it', { skip }, async () => {
  const id = await new PgRunRecorder(pool).start({ role: 'executor', channelKey: '@lo_pg', model: 'm', agentId, toolsOffered: ['read_a', 'publish_post'] });
  const { rows } = await pool.query(`SELECT tools_offered FROM editor_runs WHERE id = $1`, [id]);
  assert.deepEqual(rows[0].tools_offered, ['read_a', 'publish_post']);
  const old = await new PgRunRecorder(pool).start({ role: 'executor', channelKey: '@lo_pg', model: 'm' });
  assert.equal((await pool.query(`SELECT tools_offered FROM editor_runs WHERE id = $1`, [old])).rows[0].tools_offered, null);
});
