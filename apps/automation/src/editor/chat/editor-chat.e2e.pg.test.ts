/**
 * End-to-end (spec 010 SC-3): chat message → save_draft → schedule_draft →
 * reserved slot → the reserved dispatcher publishes it at the time through a
 * fake Telegram → the draft is published. Real throwaway Postgres, scripted LLM,
 * zero network. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { PgRunRecorder } from '../harness/run-recorder';
import { FakeBudget } from '../harness/testing/fakes';
import type { LlmClient, LlmRequest, LlmResponse } from '../llm/llm.types';
import { ReadonlyQueryService } from '../db/readonly-query.service';
import { SkillLibrary } from '../skills/skill-library';
import { buildReadTools } from '../tools/read-tools';
import { buildComposeTools } from '../tools/compose-tools';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository, rowToSlot } from '../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorChatRepository } from '../repo/editor-chat.repository';
import { ReservedDispatcher } from '../publish/reserved-dispatcher';
import { SponsoredPublisher } from '../publish/sponsored.publisher';
import { AdOrdersRepository } from '../../payments/ad-orders.repository';
import { DraftsService } from './drafts.service';
import { buildComposerTools } from './composer-tools';
import { EditorChatService } from './editor-chat.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@chat_test_e2e';
const NOW = new Date('2030-03-04T07:00:00Z');       // Monday 09:00 Kyiv (UTC+2)
const AT  = new Date('2030-03-05T17:00:00Z');       // tomorrow 19:00 Kyiv
let pool: Pool;
const runIds: string[] = [];

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM editor_chats WHERE id IN (SELECT chat_id FROM editor_drafts WHERE channel_key = $1)`, [CH]);
  await pool.query(`DELETE FROM editor_drafts WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  if (runIds.length) await pool.query(`DELETE FROM editor_runs WHERE id = ANY($1::uuid[])`, [runIds]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  // An own channel WITHOUT an editor card: the chat drafts with the default card and creates a minimal one on schedule.
  await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine, kind) VALUES ($1, 'chat_test_e2e', 'Чат-тест', true, 'public')`, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const SPEC = {
  format: 'photo', title: 'Туманність Кільце від Webb', origin: 'external',
  body: [
    { type: 'lead', text: 'Webb показав туманність Кільце в інфрачервоному світлі' },
    { type: 'p', text: 'Оболонки газу навколо білого карлика — рештки зорі, схожої на Сонце. Їм кілька тисяч років.' },
  ],
  media: [{ url: 'https://images-assets.nasa.gov/ring.jpg' }],
  hashtags: ['космос'],
  source: { url: 'https://www.nasa.gov/chat-test-ring-nebula', label: 'NASA' },
};

/** Scripted composer: save → (read the draft id from the tool result) → schedule → answer. */
class ScriptedComposer implements LlmClient {
  readonly requests: LlmRequest[] = [];
  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const n = this.requests.length;
    const msg = (content: string | null, calls?: Array<{ name: string; args: unknown }>): LlmResponse => ({
      message: { role: 'assistant', content, ...(calls ? { toolCalls: calls.map((c, i) => ({ id: `c${n}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })) } : {}) },
      finishReason: calls ? 'tool_calls' : 'stop',
      usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.0001 },
    });
    if (n === 1) return msg(null, [{ name: 'save_draft', args: { channel: CH, spec: SPEC } }]);
    if (n === 2) {
      const saved = JSON.parse((req.messages.at(-1) as any).content);
      assert.equal(saved.lint.ok, true, JSON.stringify(saved.lint));
      return msg(null, [{ name: 'schedule_draft', args: { draft_id: saved.draft_id, at: '2030-03-05 19:00' } }]);
    }
    return msg('Заплановано на вівторок, 2030-03-05 о 19:00 (Київ).');
  }
}

test('chat → draft → schedule → reserved slot → dispatcher publishes at the time → draft published', { skip }, async () => {
  let clock = NOW;
  const now = () => clock;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const repo = new EditorChatRepository(pool);
  const skills = new SkillLibrary();
  const sent: Array<{ channelKey: string; messages: unknown[] }> = [];
  const notes: string[] = [];
  const publisher = { send: async (channelKey: string, messages: unknown[]) => { sent.push({ channelKey, messages }); return { messageIds: [4242] }; } };
  const drafts = new DraftsService({
    pool, repo, channels, plans, publisher, recordPublish: () => {}, isPaused: () => false,
    notify: async (t) => { notes.push(t); }, now,
  });
  const registry = new ToolRegistry([
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
    ...buildComposeTools(),
    ...buildComposerTools({ drafts, repo }),
  ]);
  const llm = new ScriptedComposer();
  const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), budget: new FakeBudget(), enabled: () => true });
  const chat = new EditorChatService({ repo, drafts, memory, loop, registry, skills, env: () => undefined, enabled: () => true, now });

  // 1. the owner asks for a post and a schedule in one message
  const c = await chat.createChat();
  const { message } = await chat.sendMessage(c.id, `Зроби пост про туманність Кільце для ${CH} і заплануй на завтра на 19:00`);
  if (message.runId) runIds.push(message.runId);
  assert.match(message.content, /2030-03-05 о 19:00/);
  assert.equal(message.draftIds.length, 1);

  const { chat: chatRow, messages, drafts: chatDrafts } = await chat.getChat(c.id);
  assert.equal(chatRow.title, `Зроби пост про туманність Кільце для ${CH} і заплануй`.slice(0, 60));
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  const draft = chatDrafts[0];
  assert.equal(draft.status, 'scheduled');
  assert.equal(draft.scheduledAt!.toISOString(), AT.toISOString());
  assert.equal(sent.length, 0, 'nothing is sent while scheduling');

  // minimal card (mode off) + reserved slot with the spec
  const card = (await channels.get(CH))!;
  assert.deepEqual([card.mode, card.title, card.crosspost, card.hashtags.length], ['off', 'Чат-тест', false, 0]);
  const slot = (await plans.getSlot(draft.slotId!))!;
  assert.deepEqual([slot.kind, slot.status, slot.scheduledAt.toISOString(), slot.topic], ['reserved', 'planned', AT.toISOString(), 'Чат: Туманність Кільце від Webb']);
  const plan = await plans.getActivePlan(CH, '2030-03-05');
  assert.equal(plan?.rationale, 'reserved only');

  // 2. the dispatcher (no LLM) — claims only this test channel's slots so it never touches other rows in a shared scratch DB
  const claimMine = async (at: Date, limit: number) => {
    const { rows } = await pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id IN (SELECT id FROM editor_slots WHERE status = 'planned' AND kind = 'reserved' AND channel_key = $3
                      AND scheduled_at <= $1 ORDER BY scheduled_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [at, limit, CH]);
    return rows.map(rowToSlot);
  };
  const orders = new AdOrdersRepository(pool);
  const dispatcher = new ReservedDispatcher({
    plans: { claimDueReserved: claimMine }, orders,
    sponsored: new SponsoredPublisher({ plans, channels, publisher, orders, recordPublish: () => {}, notify: async (t) => { notes.push(t); } }),
    manual: drafts,
  });

  clock = new Date(AT.getTime() - 60_000);
  assert.equal(await dispatcher.publishDue(clock), 0, 'not before its time');
  clock = new Date(AT.getTime() + 30_000);
  assert.equal(await dispatcher.publishDue(clock), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelKey, CH);

  const after = (await drafts.get(draft.id))!;
  assert.equal(after.status, 'published');
  const slotAfter = (await plans.getSlot(draft.slotId!))!;
  assert.equal(slotAfter.status, 'published');
  const { rows } = await pool.query(`SELECT strategy_type, editor_slot_id, source_url, format FROM published_posts WHERE id = $1`, [after.publishedPostId]);
  assert.deepEqual(rows[0], { strategy_type: 'chat', editor_slot_id: slot.id, source_url: SPEC.source.url, format: 'photo' });
  assert.equal(await dispatcher.publishDue(new Date(AT.getTime() + 120_000)), 0, 'never twice');
  assert.deepEqual(notes, []);

  // 3. dedup: the same source cannot be published to the channel again within 7 days
  clock = new Date(); // published_posts.posted_at is the DB's now()
  const again: any = await drafts.save({ chatId: c.id, channel: CH, spec: SPEC });
  assert.equal(((await drafts.publish(again.draft.id)) as any).error, 'source_already_posted');
});
