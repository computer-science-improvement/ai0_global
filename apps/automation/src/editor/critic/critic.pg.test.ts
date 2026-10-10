/**
 * Spec 034 T2 (FR-004) against a real throwaway Postgres: migration 068 is
 * idempotent; publish_post with the critic gate stores the verdict on the slot
 * (approval card payload via ApprovalsService), a reject skips the slot and
 * never sends, and a chat draft keeps its advisory verdict.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { EditorChatRepository } from '../repo/editor-chat.repository';
import { buildRoleTools } from '../tools/role-tools';
import { ApprovalsRepository } from '../approval/approvals.repository';
import { ApprovalsService } from '../approval/approvals.service';
import { syncAgentsFor } from '../approval/pg-test-agents';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { CRITIC_SCORE_KEYS, type CriticScores } from './critic';
import { CriticService } from './critic.service';
import { CriticGate } from './critic-gate';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@critic_pg';
const NOW = new Date('2030-05-06T09:00:00Z');
const MIGRATION = readFileSync(join(__dirname, '../../../../../database/migrations/068_critic.sql'), 'utf8');
let pool: Pool;
let planId: string;

async function cleanup() {
  await pool.query(`DELETE FROM editor_drafts WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await new EditorChannelsRepository(pool).upsert(makeCard({ channelKey: CH, mode: 'approve' }));
  await syncAgentsFor(pool, [CH]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, '2030-05-07', 'План') RETURNING id`, [CH])).rows[0].id;
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const all = (n: number) => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const critique = (verdict: string, scores: CriticScores, notes: string) => ({ calls: [{ name: 'submit_critique', args: { scores, verdict, notes } }] });

async function runningSlot(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, attempts)
     VALUES ($1, $2, '2030-05-07T07:00:00Z', 'photo', 'Туманність Кільце', 'running', 1) RETURNING id`, [planId, CH]);
  return rows[0].id;
}

function harness(mode: 'approve' | 'live', slotId: string, turns: ConstructorParameters<typeof FakeLlm>[0]) {
  const plans = new EditorPlansRepository(pool);
  const sent: unknown[] = [];
  const tools = buildRoleTools({
    pool, plans, memory: {} as any, channels: {} as any,
    publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [1] }; } },
    recordPublish: () => {}, now: () => NOW,
  });
  const critic = new CriticService({
    loop: new AgentLoop({ llm: new FakeLlm(turns), recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true }),
    env: () => undefined, now: () => NOW,
  });
  const gate = new CriticGate({ critic, plans }, { slotId, channelKey: CH, mode, resourceRef: `telegram:${CH}`, platform: 'telegram', voice: {} });
  const card = makeCard({ channelKey: CH, mode, quietStartHour: 0, quietEndHour: 0, minGapMinutes: 0 });
  const ctx = { runId: 'r', role: 'executor' as const, channelKey: CH, slotId, extras: { card, critic: gate } };
  return { publish: tools.find((t) => t.name === 'publish_post')!, ctx, sent };
}

test('migration 068 is idempotent: editor_slots.critic and editor_drafts.critic exist after a second apply', { skip }, async () => {
  await pool.query(MIGRATION);
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.columns WHERE column_name = 'critic' AND table_name IN ('editor_slots','editor_drafts') ORDER BY 1`);
  assert.deepEqual(rows.map((r) => r.table_name), ['editor_drafts', 'editor_slots']);
  const v = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '068_critic'`);
  assert.equal(v.rows[0].n, 1);
});

test('approval: a final revise goes to the owner — the card payload carries verdict, scores and notes', { skip }, async () => {
  const id = await runningSlot();
  const h = harness('approve', id, [
    critique('revise', { ...all(5), audience_asks: 3 }, 'Зайве питання до читачів.'),
    critique('revise', { ...all(5), audience_asks: 3 }, 'Питання лишилося.'),
  ]);
  const first: any = await h.publish.execute({ spec: makeSpec({ source: { url: 'https://src.example/c1', label: 'NASA' } }) }, h.ctx);
  assert.equal(first.error, 'critic_revise');
  const second: any = await h.publish.execute({ spec: makeSpec({ title: 'Друга версія', source: { url: 'https://src.example/c1', label: 'NASA' } }) }, h.ctx);
  assert.equal(second.awaiting_approval, true, JSON.stringify(second));
  const channels = new EditorChannelsRepository(pool);
  const svc = new ApprovalsService({ repo: new ApprovalsRepository(pool), card: (k) => channels.get(k), now: () => NOW });
  const card = (await svc.list({ channel: CH })).items.find((c) => c.id === id)!;
  assert.equal(card.critic?.verdict, 'revise');
  assert.equal(card.critic?.final, true);
  assert.equal(card.critic?.notes, 'Питання лишилося.');
  assert.equal(card.critic?.scores?.audience_asks, 3);
  assert.equal(card.critic?.history?.[0].notes, 'Зайве питання до читачів.');
  assert.equal(h.sent.length, 0);
  const bulk = await svc.bulk({ channel: CH });
  assert.equal(bulk.approved, 0, 'never bulk-approved');
});

test('live: a reject skips the slot with the reason and the verdict; nothing is sent', { skip }, async () => {
  const id = await runningSlot();
  const h = harness('live', id, [critique('reject', { ...all(5), grounding: 1 }, 'Цифри немає в джерелі.')]);
  const spec = makeSpec({
    title: 'Марсохід знайшов глину', source: { url: 'https://src.example/c2', label: 'NASA' },
    body: [{ type: 'lead', text: 'Perseverance знайшов глинисті мінерали в кратері Єзеро' }, { type: 'p', text: 'Зразки відправлять на Землю в 2033 році.' }],
  });
  const r: any = await h.publish.execute({ spec }, h.ctx);
  assert.equal(r.critic_rejected, true, JSON.stringify(r));
  assert.equal(h.sent.length, 0);
  const slot = await new EditorPlansRepository(pool).getSlot(id);
  assert.equal(slot?.status, 'skipped');
  assert.match(slot?.error ?? '', /^critic_rejected: reject \(grounding 1\): Цифри немає/);
  assert.equal(slot?.critic?.verdict, 'reject');
});

test('chat draft: the advisory verdict round-trips and is cleared by null', { skip }, async () => {
  const repo = new EditorChatRepository(pool);
  const d = await repo.insertDraft({ chatId: null, channelKey: CH, spec: makeSpec(), preview: null, lint: null });
  const critic = {
    verdict: 'pass' as const, scores: all(5), notes: 'Добре.', model_verdict: 'pass' as const, reason: 'scores_ok', pass: 1,
    slop_warnings: [], model: 'm', run_id: null, cost_usd: 0.001, at: NOW.toISOString(),
  };
  assert.deepEqual((await repo.updateDraft(d.id, { critic }))?.critic, critic);
  assert.equal((await repo.getDraft(d.id))?.critic?.verdict, 'pass');
  assert.equal((await repo.updateDraft(d.id, { critic: null }))?.critic, undefined);
});
