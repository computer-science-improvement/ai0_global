/**
 * Spec 040 T13 against a throwaway Postgres: migration 079 (idempotent, its agent_skills backfill), the chat / production
 * budget split, the host-failure TTL, memory source_text, retry_at, own skills on write, editor_chat_messages.actions.
 * Skipped unless EDITOR_PG_TEST_URL is set. Spend and claim checks run in a rolled-back transaction (llm_usage and the slot
 * queue are shared by every suite).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { withLlmContext } from '../common/ai/usage/llm-context';
import { BudgetService } from './harness/budget.service';
import { PgHostFailures } from './net/host-failures';
import { EditorMemoryRepository } from './repo/editor-memory.repository';
import { EditorPlansRepository } from './repo/editor-plans.repository';
import { EditorChatRepository } from './repo/editor-chat.repository';
import { SkillStore } from './agents/skill-store';
import { emptyTurn } from './chat/turn-record';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', 'database', 'migrations', '079_agent_reliability.sql'), 'utf8');
const CH = '@pgtest_reliability_040';
const HOST = 'pgtest-040.example.org';
const HANDLE = 'pgtest_rel_040';
const SHARED = 'pgtest-040-tone';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM skills WHERE agent_id IS NULL AND name = $1`, [SHARED]);
  await pool.query(`DELETE FROM source_host_failures WHERE host = $1`, [HOST]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(MIGRATION);
  await cleanup();
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'shadow', '{"text":1}')`, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

async function rolledBack(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

async function agent(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO agents (kind, scope, name, handle) VALUES ('orchestrator', 'resource', 'PG 040', $1) RETURNING id`, [HANDLE]);
  return rows[0].id;
}

test('079 applies again without errors; the editor.chat pool, the new columns and statuses are there', { skip }, async () => {
  await pool.query(MIGRATION);
  const { rows } = await pool.query(`SELECT daily_usd FROM llm_budgets WHERE scope_kind = 'feature_prefix' AND scope_key = 'editor.chat'`);
  assert.equal(rows.length, 1);
  const cols = await pool.query(
    `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
      WHERE (table_name, column_name) IN (('editor_runs','repeat_blocked'),('editor_runs','tools_dropped'),('editor_slots','retry_at'),
        ('manager_reviews','signature'),('editor_channel_memory','source_text'),('editor_chat_messages','actions'),('agent_directives','supersedes'))`);
  assert.equal(cols.rows.length, 7);
  await rolledBack(async (c) => {
    await c.query(`INSERT INTO editor_runs (role, channel_key, model, status) VALUES ('planner', $1, 'm', 'no_terminal')`, [CH]);
  });
});

test('budget: chat turns do not count against the agents\' production cap and are not blocked by it', { skip }, async () => {
  await rolledBack(async (c) => {
    const base = await c.query(`SELECT COALESCE(SUM(cost_usd), 0)::float AS s FROM llm_usage
      WHERE feature LIKE 'editor.%' AND feature <> 'editor.chat' AND feature NOT LIKE 'editor.chat.%' AND at >= now() - interval '2 days'`);
    const limit = Number(base.rows[0].s) + 1;
    const usage = (feature: string, cost: number) => c.query(
      `INSERT INTO llm_usage (provider, model, feature, cost_usd, cost_source) VALUES ('openrouter', 'm', $1, $2, 'estimate')`, [feature, cost]);
    const budget = new BudgetService(c as unknown as Pool, { globalDailyUsd: limit, channelDailyUsd: 1000 });
    const check = (feature: string) => withLlmContext({ feature }, () => budget.check(null));

    await usage('editor.chat.composer', 50);
    await usage('editor.chat.manager', 50);
    assert.deepEqual(await check('editor.planner'), { ok: true }, '$100 of chat turns leave production alone');
    await usage('editor.planner', 1.5);
    const v = await check('editor.executor');
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.scope, 'global');
    assert.ok(!v.ok && v.spentUsd < limit + 1, 'the sum has production spend only');
    assert.deepEqual(await check('editor.chat.composer'), { ok: true }, 'a chat turn is not stopped by the production cap');
  });
});

test('host failures: a refused host is blocked for 24 h, repeats count, then it is free again', { skip }, async () => {
  let now = new Date('2026-10-16T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  await hosts.record(HOST, 'refused', 403);
  await hosts.record(HOST, 'refused', 403);
  const b = await hosts.blocked(HOST, 'page');
  assert.equal(b?.statusCode, 403);
  assert.equal(b?.until.toISOString(), '2026-10-17T08:00:00.000Z');
  assert.equal((await pool.query(`SELECT failures FROM source_host_failures WHERE host = $1`, [HOST])).rows[0].failures, 2);
  now = new Date('2026-10-17T08:00:01Z');
  assert.equal(await hosts.blocked(HOST, 'page'), null);
  await hosts.record(HOST, 'feed_unparseable');
  assert.equal(await hosts.blocked(HOST, 'page'), null, 'a feed failure does not block pages');
  assert.equal((await hosts.blocked(HOST, 'feed'))?.reason, 'feed_unparseable');
  assert.equal((await pool.query(`SELECT failures FROM source_host_failures WHERE host = $1`, [HOST])).rows[0].failures, 1, 'an expired block starts over');
});

test('memory: an owner rule keeps the owner\'s words in source_text', { skip }, async () => {
  const memory = new EditorMemoryRepository(pool);
  const id = await memory.add(CH, 'rule', 'Без хештегів у постах', { source: 'chat' }, 'owner', '> прибери хештеги\n> взагалі без них');
  const plain = await memory.add(CH, 'insight', 'Вечірні пости читають краще', null, 'reviewer');
  const { rows } = await pool.query(`SELECT id, source_text FROM editor_channel_memory WHERE id = ANY($1) ORDER BY id`, [[id, plain]]);
  assert.deepEqual(rows.map((r) => r.source_text), ['> прибери хештеги\n> взагалі без них', null]);
});

test('retry_at: a failed attempt waits for its retry, scheduled_at keeps the planned time', { skip }, async () => {
  const plans = new EditorPlansRepository(pool);
  const at = new Date('2099-03-01T10:00:00Z');
  const planId = await plans.createPlan(CH, '2099-03-01', 'retry test', null, [{ scheduledAt: at, format: 'text', topic: 'Тема для повтору', angle: null, sourceHints: [], isExperiment: false }]);
  const [slot] = await plans.listSlots(CH, planId);
  await plans.updateSlot(slot.id, { retryAt: new Date(at.getTime() + 30 * 60_000) });
  assert.equal((await plans.getSlot(slot.id))!.retryAt?.toISOString(), '2099-03-01T10:30:00.000Z');
  await rolledBack(async (c) => {
    const queue = new EditorPlansRepository(c as unknown as Pool);
    assert.ok(!(await queue.claimDue(new Date('2099-03-01T10:10:00Z'), 1000)).some((s) => s.id === slot.id), 'not before retry_at');
    const claimed = (await queue.claimDue(new Date('2099-03-01T10:31:00Z'), 1000)).find((s) => s.id === slot.id);
    assert.equal(claimed?.scheduledAt.toISOString(), at.toISOString());
    assert.equal(claimed?.retryAt, undefined, 'claiming clears retry_at');
  });
});

test('skills: an own skill is on from its first write; the profile tone attaches once and keeps the owner\'s toggle', { skip }, async () => {
  const id = await agent();
  const store = new SkillStore(pool);
  const w = await store.writeAgentSkill({
    agentId: id, name: 'pgtest-040-own', description: 'Як писати пости каналу коротко', appliesTo: ['executor'], body: 'Пиши коротко.', author: 'owner',
  });
  assert.ok('ok' in w && w.ok, JSON.stringify(w));
  const row = async (skillId: string) => (await pool.query(`SELECT enabled, inline FROM agent_skills WHERE agent_id = $1 AND skill_id = $2`, [id, skillId])).rows[0];
  assert.deepEqual(await row((w as any).skill.id), { enabled: true, inline: true });

  assert.equal(await store.attachSharedIfUnset(id, SHARED), 'missing');
  const shared = (await pool.query(
    `INSERT INTO skills (name, scope, description, applies_to, body, created_by) VALUES ($1, 'global', 'Тон для тесту 040', '{executor}', 'Тон.', 'owner') RETURNING id`,
    [SHARED])).rows[0].id;
  assert.equal(await store.attachSharedIfUnset(id, SHARED), 'attached');
  await pool.query(`UPDATE agent_skills SET enabled = false WHERE agent_id = $1 AND skill_id = $2`, [id, shared]);
  assert.equal(await store.attachSharedIfUnset(id, SHARED), 'exists');
  assert.equal((await row(shared)).enabled, false, 'the owner turned it off: it stays off');
});

test('079 backfill: own skills without a toggle are turned on; overrides and the owner\'s toggles are left alone', { skip }, async () => {
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM skills WHERE agent_id IS NULL AND name = $1`, [SHARED]);
  const id = await agent();
  const skill = async (name: string, body: string) => (await pool.query(
    `INSERT INTO skills (name, scope, agent_id, description, applies_to, body, created_by) VALUES ($1, 'agent', $2, 'Скіл для тесту 040', '{executor}', $3, 'owner') RETURNING id`,
    [name, id, body])).rows[0].id as string;
  const own = await skill('pgtest-040-a', 'Коротко.');
  const long = await skill('pgtest-040-b', 'х'.repeat(4001));
  const off = await skill('pgtest-040-c', 'Вимкнено власником.');
  await pool.query(`INSERT INTO agent_skills (agent_id, skill_id, enabled, inline) VALUES ($1, $2, false, false)`, [id, off]);
  await pool.query(`INSERT INTO skills (name, scope, description, applies_to, body, created_by) VALUES ($1, 'global', 'Спільний скіл 040', '{executor}', 'Спільний.', 'owner')`, [SHARED]);
  const override = await skill(SHARED, 'Своя версія спільного.');

  await pool.query(MIGRATION);
  await pool.query(MIGRATION);
  const { rows } = await pool.query(`SELECT skill_id, enabled, inline FROM agent_skills WHERE agent_id = $1`, [id]);
  const by = new Map(rows.map((r) => [r.skill_id, { enabled: r.enabled, inline: r.inline }]));
  assert.deepEqual(by.get(own), { enabled: true, inline: true });
  assert.deepEqual(by.get(long), { enabled: true, inline: false }, 'too long to be always in context');
  assert.deepEqual(by.get(off), { enabled: false, inline: false });
  assert.equal(by.has(override), false, 'an override follows the shared skill\'s toggles');
});

test('chat messages keep what the turn\'s tools did; an old message has none', { skip }, async () => {
  const repo = new EditorChatRepository(pool);
  const chat = await repo.createChat();
  try {
    const actions = { ...emptyTurn(), cards: [{ id: 'pa-0001', kind: 'owner_rule' }], rules: [7], tools: ['add_owner_rule'] };
    await repo.addMessage({ chatId: chat.id, role: 'user', content: 'запамʼятай: без хештегів' });
    await repo.addMessage({ chatId: chat.id, role: 'assistant', content: 'Записав правило #7.', actions });
    const [u, a] = await repo.listMessages(chat.id);
    assert.equal(u.actions ?? null, null);
    assert.deepEqual(a.actions, actions);
  } finally {
    await repo.deleteChat(chat.id);
  }
});
