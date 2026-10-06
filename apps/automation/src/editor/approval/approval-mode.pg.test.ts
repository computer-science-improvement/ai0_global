/**
 * Spec 031 T1 against a real throwaway Postgres: migration 057 keeps existing
 * modes, new agents and cards start in approve, and leaving approval for
 * shadow drops the posts that still wait. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { mergeCard } from '../api/card-input';
import { syncAgentsFor } from './pg-test-agents';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const LIVE = '@apm_live_pg';
const SHADOW = '@apm_shadow_pg';
const FRESH = '@apm_fresh_pg';
const WAIT = '@apm_wait_pg';
const KEYS = [LIVE, SHADOW, FRESH, WAIT];
const MIGRATION = join(__dirname, '../../../../../database/migrations/057_approval_mode.sql');
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM agents WHERE scope_id = ANY($1::text[])`, [KEYS.map((k) => `telegram:${k}`)]);
  await pool.query(`DELETE FROM agents WHERE handle IN ('apm_plain_pg')`);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = ANY($1::text[])`, [KEYS]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = ANY($1::text[])`, [KEYS]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('migration 057 is idempotent and never changes the mode of an existing resource', { skip }, async () => {
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live'), ($2, 'shadow')`, [LIVE, SHADOW]);
  await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode, created_by) VALUES ('orchestrator', 'resource', $1, 'Live', 'apm_live_orch', 'live', 'owner')`,
    [`telegram:${LIVE}`]);
  await syncAgentsFor(pool, [LIVE, SHADOW]);
  await pool.query(readFileSync(MIGRATION, 'utf8'));
  await pool.query(readFileSync(MIGRATION, 'utf8'));
  const { rows } = await pool.query(`SELECT channel_key, mode FROM editor_channels WHERE channel_key = ANY($1::text[]) ORDER BY channel_key`, [[LIVE, SHADOW]]);
  assert.deepEqual(rows.map((r) => [r.channel_key, r.mode]), [[LIVE, 'live'], [SHADOW, 'shadow']]);
  const a = await pool.query(`SELECT mode FROM agents WHERE handle = 'apm_live_orch'`);
  assert.equal(a.rows[0].mode, 'live');
  // The new values are accepted; nonsense is still rejected.
  await pool.query(`UPDATE editor_channels SET mode = 'approve' WHERE channel_key = $1`, [SHADOW]);
  await assert.rejects(pool.query(`UPDATE editor_channels SET mode = 'auto' WHERE channel_key = $1`, [SHADOW]));
  // An approved slot always carries its approval time (defence in depth for the safety invariant).
  const plan = await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, '2030-01-01') RETURNING id`, [SHADOW]);
  await assert.rejects(pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status) VALUES ($1, $2, now(), 'text', 't', 'approved')`,
    [plan.rows[0].id, SHADOW]), /editor_slots_approved_at_chk/);
});

test('new agents default to approve; a card created without a mode is approve and so is its synced orchestrator', { skip }, async () => {
  await pool.query(`INSERT INTO agents (kind, scope, scope_id, name, handle, created_by) VALUES ('orchestrator', 'network', 'apm-net-pg', 'x', 'apm_plain_pg', 'owner')`);
  const plain = await pool.query(`SELECT mode FROM agents WHERE handle = 'apm_plain_pg'`);
  assert.equal(plain.rows[0].mode, 'approve', 'the agents.mode column default');

  const channels = new EditorChannelsRepository(pool);
  const merged = mergeCard(FRESH, null, { title: 'Свіжий', brief: 'Новий ресурс' });
  assert.ok(merged.ok);
  const { card } = await channels.upsert(merged.ok ? merged.card : (null as never));
  assert.equal(card.mode, 'approve');
  assert.equal(card.approvalHoldHours, 6);
  assert.equal(card.approvalLeadHours, 12);
  const agents = new AgentsRepository(pool);
  // Only this card: a global sync here would race the other pg suites that sync their own cards.
  await new AgentRegistrySync({ agents, channels: { list: async () => [card] } }).run();
  const orch = await agents.findTop('orchestrator', 'resource', `telegram:${FRESH}`);
  assert.equal(orch?.mode, 'approve');
});

test('approve → shadow drops waiting posts (skipped, mode_changed); approve → live keeps them', { skip }, async () => {
  const channels = new EditorChannelsRepository(pool);
  const base = mergeCard(WAIT, null, { mode: 'approve' });
  assert.ok(base.ok);
  const card = base.ok ? base.card : (null as never);
  await channels.upsert(card);
  await syncAgentsFor(pool, [WAIT]);
  const plan = await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, '2030-01-02') RETURNING id`, [WAIT]);
  const ins = async (status: string) => (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, approved_at)
     VALUES ($1, $2, '2030-01-02T10:00:00Z', 'text', 't', $3, CASE WHEN $3 = 'approved' THEN now() END) RETURNING id`,
    [plan.rows[0].id, WAIT, status])).rows[0].id as string;
  const waiting = await ins('awaiting_approval');
  const approved = await ins('approved');
  const planned = await ins('planned');

  await channels.upsert({ ...card, mode: 'live' });
  const st = async (id: string) => (await pool.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [id])).rows[0];
  assert.equal((await st(waiting)).status, 'awaiting_approval', 'approve → live leaves waiting posts for the owner');

  await channels.upsert({ ...card, mode: 'approve' });
  await channels.upsert({ ...card, mode: 'shadow' });
  assert.deepEqual(await st(waiting), { status: 'skipped', error: 'mode_changed' });
  assert.deepEqual(await st(approved), { status: 'skipped', error: 'mode_changed' });
  assert.equal((await st(planned)).status, 'planned', 'unwritten slots follow the new mode');
});
