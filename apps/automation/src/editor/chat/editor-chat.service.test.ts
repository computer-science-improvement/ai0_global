import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { EditorChatMessage, EditorDraft } from '../repo/editor-chat.repository';
import { buildComposerTools } from './composer-tools';
import { EditorChatService, ChatStreamEvent } from './editor-chat.service';

const NOW = new Date('2026-10-01T09:00:00Z');
const UUID = '00000000-0000-4000-8000-000000000001';

function setup(turns: ConstructorParameters<typeof FakeLlm>[0], o: { enabled?: boolean } = {}) {
  const messages: EditorChatMessage[] = [];
  const drafts: EditorDraft[] = [];
  const titles: Array<string | undefined> = [];
  const calls: string[] = [];
  const draft = (status: EditorDraft['status'] = 'draft'): EditorDraft => ({
    id: UUID, chatId: 'c1', channelKey: '@chan', spec: makeSpec(), preview: '<b>Телескоп</b>', lint: { ok: true, errors: [], warnings: [] },
    status, scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: NOW, updatedAt: NOW,
  });
  const fakeDrafts: any = {
    save: async (i: any) => { calls.push(`save:${i.channel}`); const d = draft(); drafts.push(d); return { ok: true, draft: d, card: makeCard(), lint: d.lint }; },
    publish: async (id: string) => { calls.push(`publish:${id}`); return { ok: true, draft: draft('published'), messageId: 9, warnings: [] }; },
    schedule: async (id: string, at: Date) => { calls.push(`schedule:${id}:${at.toISOString()}`); return { ok: true, draft: draft('scheduled'), local: 'x' }; },
    cancel: async () => ({ ok: true, draft: draft('canceled') }),
    list: async () => drafts,
    resolveCard: async (k: string) => (k === '@chan' ? { card: makeCard(), hasCard: true } : null),
  };
  const repo: any = {
    createChat: async () => ({ id: 'c1', title: 'Новий чат', createdAt: NOW, updatedAt: NOW }),
    listChats: async () => [],
    getChat: async (id: string) => (id === 'c1' ? { id, title: 'Новий чат', createdAt: NOW, updatedAt: NOW } : null),
    deleteChat: async () => true,
    touchChat: async (_id: string, title?: string) => { titles.push(title); },
    addMessage: async (m: any) => { const row = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: m.draftIds ?? [], runId: m.runId ?? null, createdAt: NOW }; messages.push(row); return row; },
    listMessages: async () => [...messages],
    listDrafts: async () => [...drafts],
    myChannels: async () => [{ channelKey: '@chan', title: 'Тест', hasCard: true, mode: 'shadow' }, { channelKey: '@other', title: null, hasCard: false, mode: null }],
  };
  const llm = new FakeLlm(turns);
  const recorder = new MemoryRecorder();
  const loop = new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true });
  const svc = new EditorChatService({
    repo, drafts: fakeDrafts, memory: { listActive: async () => [] }, loop,
    registry: new ToolRegistry(buildComposerTools({ drafts: fakeDrafts, repo })), skills: new SkillLibrary(),
    env: () => undefined, enabled: () => o.enabled ?? true, now: () => NOW,
  });
  return { svc, llm, messages, drafts, titles, calls, recorder };
}

test('a message runs the composer with the chat history, persists both turns and streams events', async () => {
  const s = setup([
    { calls: [{ name: 'save_draft', args: { channel: '@chan', spec: makeSpec() } }] },
    { text: 'Чернетка готова — подивись превʼю.' },
    { text: 'Скоротив.' },
  ]);
  const events: ChatStreamEvent[] = [];
  const r = await s.svc.sendMessage('c1', 'Зроби пост про туманність для @chan', { onEvent: (e) => events.push(e) });
  assert.equal(r.message.content, 'Чернетка готова — подивись превʼю.');
  assert.deepEqual(r.message.draftIds, [UUID]);
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(s.titles[0], 'Зроби пост про туманність для @chan');
  assert.deepEqual(events.map((e) => e.type), ['tool_call', 'draft', 'tool_result', 'text', 'message']);
  assert.equal(s.recorder.runs[0].role, 'composer');
  assert.equal(s.recorder.runs[0].channelKey, null, 'global budget scope');
  // the channel named in the message is the chat's channel: its card is in the system prompt
  assert.match((s.llm.requests[0].messages[0] as any).content, /Канал цієї розмови: «Тест» \(@chan\)/);
  assert.match((s.llm.requests[0].messages[0] as any).content, /2026-10-01 12:00 \(Київ/);

  // second turn: prior turns come back as history, the draft summarised with its id
  await s.svc.sendMessage('c1', 'коротше');
  const msgs = s.llm.requests[2].messages;
  assert.deepEqual(msgs.slice(1).map((m: any) => m.role), ['user', 'assistant', 'user']);
  assert.match((msgs[2] as any).content, new RegExp(`\\[чернетки: ${UUID} · @chan · photo`));
  assert.equal(s.titles.filter(Boolean).length, 1, 'title only from the first message');
});

test('publish/schedule tools need an explicit request in the latest message', async () => {
  const noIntent = setup([
    { calls: [{ name: 'publish_draft', args: { draft_id: UUID } }, { name: 'schedule_draft', args: { draft_id: UUID, at: '2026-10-02 19:00' } }] },
    { text: 'Запропонував кнопки.' },
  ]);
  const events: ChatStreamEvent[] = [];
  await noIntent.svc.sendMessage('c1', 'Підготуй пост для @chan', { onEvent: (e) => events.push(e) });
  assert.deepEqual(noIntent.calls, []);
  const results = events.filter((e) => e.type === 'tool_result') as any[];
  assert.ok(results.every((e) => !e.ok && /needs_explicit_request/.test(e.summary)));

  const withIntent = setup([
    { calls: [{ name: 'schedule_draft', args: { draft_id: UUID, at: '2026-10-02 19:00' } }] },
    { text: 'Заплановано на 2026-10-02 о 19:00.' },
  ]);
  await withIntent.svc.sendMessage('c1', 'Заплануй на завтра о 19:00');
  assert.deepEqual(withIntent.calls, [`schedule:${UUID}:2026-10-02T16:00:00.000Z`]);
});

test('failures become an assistant message; disabled chat and a busy chat are refused up front', async () => {
  const s = setup([new Error('upstream 500')]);
  const events: ChatStreamEvent[] = [];
  const r = await s.svc.sendMessage('c1', 'привіт', { onEvent: (e) => events.push(e) });
  assert.match(r.message.content, /помилка/i);
  assert.deepEqual(events.map((e) => e.type), ['error', 'message']);

  await assert.rejects(setup([], { enabled: false }).svc.sendMessage('c1', 'привіт'), /chat_disabled|Service Unavailable/);
  await assert.rejects(s.svc.sendMessage('nope', 'привіт'), /Not Found|chat_not_found/);
  await assert.rejects(s.svc.sendMessage('c1', '   '), /Bad Request|invalid_text/);

  const slow = setup([{ text: 'ok' }]);
  const first = slow.svc.sendMessage('c1', 'раз');
  await assert.rejects(slow.svc.sendMessage('c1', 'два'), /Conflict|chat_busy/);
  await first;
});

test('without a known channel the prompt tells the composer to ask which channel', async () => {
  const s = setup([{ text: 'У який канал писати?' }]);
  await s.svc.sendMessage('c1', 'Зроби пост про космос');
  assert.match((s.llm.requests[0].messages[0] as any).content, /Канал ще не визначено/);
});
