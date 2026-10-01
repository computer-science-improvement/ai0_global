/** EditorChatRepository against a real throwaway Postgres (047). Skipped unless EDITOR_PG_TEST_URL is set. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EditorChatRepository } from './editor-chat.repository';
import { EditorChannelsRepository } from './editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@chat_test_repo';
const CARDED = '@chat_test_repo_card';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM editor_drafts WHERE channel_key IN ($1, $2)`, [CH, CARDED]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key IN ($1, $2)`, [CH, CARDED]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key IN ($1, $2)`, [CH, CARDED]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, 'chat_test_repo', 'Репо-тест', true)`, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('chats, messages and drafts round-trip; deleting a chat keeps its drafts', { skip }, async () => {
  const repo = new EditorChatRepository(pool);
  const chat = await repo.createChat();
  assert.equal(chat.title, 'New chat');
  await repo.touchChat(chat.id, 'Перше повідомлення');
  await repo.touchChat(chat.id, 'Друге');
  assert.equal((await repo.getChat(chat.id))!.title, 'Перше повідомлення', 'the title is set once');

  await repo.addMessage({ chatId: chat.id, role: 'user', content: 'привіт' });
  const d1 = await repo.insertDraft({ chatId: chat.id, channelKey: CH, spec: { title: 'a' }, preview: '<b>a</b>', lint: { ok: true, errors: [], warnings: [] } });
  const d2 = await repo.insertDraft({ chatId: chat.id, channelKey: CH, spec: { title: 'b' }, preview: null, lint: null });
  await repo.addMessage({ chatId: chat.id, role: 'assistant', content: 'готово', draftIds: [d1.id, d2.id] });
  const msgs = await repo.listMessages(chat.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(msgs[1].draftIds, [d1.id, d2.id]);
  assert.deepEqual((await repo.listMessages(chat.id, 1)).map((m) => m.content), ['готово'], 'limit keeps the latest, in order');

  const at = new Date(Date.now() + 86_400_000);
  const upd = (await repo.updateDraft(d2.id, { status: 'scheduled', scheduledAt: at }))!;
  assert.equal(upd.status, 'scheduled');
  assert.equal(upd.scheduledAt!.toISOString(), at.toISOString());
  const listed = await repo.listDrafts({ chatId: chat.id });
  assert.deepEqual(listed.map((d) => d.id), [d2.id, d1.id], 'scheduled first');
  assert.deepEqual((await repo.listDrafts({ status: 'scheduled', chatId: chat.id })).map((d) => d.id), [d2.id]);

  assert.equal(await repo.deleteChat(chat.id), true);
  assert.equal((await repo.listMessages(chat.id)).length, 0);
  assert.equal((await repo.getDraft(d1.id))!.chatId, null, 'drafts outlive the chat');
});

test('myChannels: own channels plus carded ones; insertIfMissing never overwrites a card', { skip }, async () => {
  const repo = new EditorChatRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  assert.equal(await channels.insertIfMissing({ ...makeDefaultCard(CARDED, 'З карткою'), mode: 'shadow' }), true);
  assert.equal(await channels.insertIfMissing(makeDefaultCard(CARDED, 'Інша назва')), false);
  assert.deepEqual([(await channels.get(CARDED))!.mode, (await channels.get(CARDED))!.title], ['shadow', 'З карткою']);

  const mine = (await repo.myChannels()).filter((c) => c.channelKey.startsWith('@chat_test_repo'));
  assert.deepEqual(mine, [
    { channelKey: CH, title: 'Репо-тест', hasCard: false, mode: null },
    { channelKey: CARDED, title: 'З карткою', hasCard: true, mode: 'shadow' },
  ]);
});
