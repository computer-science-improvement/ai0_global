/** Spec 047 FR-003: a message to several channel agents reaches each in turn, under one turn cap; with @manager, it coordinates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import type { EditorChatMessage } from '../repo/editor-chat.repository';
import { leadingMentions } from '../agents/mentions';
import { EditorChatService, type ChatStreamEvent } from './editor-chat.service';

const NOW = new Date('2026-10-17T09:00:00Z');
const agent = (handle: string, kind = 'orchestrator', parentId: string | null = null): any =>
  ({ id: `a-${handle}`, handle, name: handle, emoji: null, kind, parentId, scope: 'resource', scopeId: `telegram:@${handle}`, mode: 'live', status: 'active' });
const AGENTS = [agent('ai_global'), agent('loko_games'), agent('nova_dev'), agent('nova_planner', 'planner', 'a-nova_dev'), agent('manager', 'manager'), agent('ai0', 'builder')];

test('leading mentions are the addressees; later ones are data', () => {
  assert.deepEqual(leadingMentions('@ai_global @loko_games @nova_dev переплануйте на завтра'), ['ai_global', 'loko_games', 'nova_dev']);
  assert.deepEqual(leadingMentions('@ai_global, @loko_games і @nova_dev — що з планом?'), ['ai_global', 'loko_games', 'nova_dev']);
  assert.deepEqual(leadingMentions('@kira подивись, як пише @nova'), ['kira']);
  assert.deepEqual(leadingMentions('> @aa @bb\n@cc текст'), ['cc'], 'quoted lines are not addressees');
});

function setup(turns: ConstructorParameters<typeof FakeLlm>[0], env: Record<string, string> = {}) {
  const messages: EditorChatMessage[] = [];
  const bound: string[] = [];
  const repo: any = {
    createChat: async () => ({ id: 'c1' }), listChats: async () => [], deleteChat: async () => true, touchChat: async () => {},
    getChat: async () => ({ id: 'c1', title: 't', createdAt: NOW, updatedAt: NOW, agentId: null }),
    setChatAgent: async (_c: string, id: string) => { bound.push(id); },
    addMessage: async (m: any) => {
      const row = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: m.draftIds ?? [], runId: null, agentId: m.agentId ?? null, actions: m.actions ?? null, createdAt: NOW };
      messages.push(row);
      return row;
    },
    listMessages: async () => [...messages], listDrafts: async () => [], myChannels: async () => [],
  };
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const byHandle = (h: string) => AGENTS.find((a) => a.handle === h) ?? null;
  const svc = new EditorChatService({
    repo, drafts: { resolveCard: async (k: string) => ({ card: makeCard({ channelKey: k }), hasCard: true }) } as any,
    memory: { listActive: async () => [] }, loop, registry: new ToolRegistry([]), skills: new SkillLibrary(),
    env: (k) => env[k], enabled: () => true, now: () => NOW,
    agents: {
      byHandle: async (h: string) => byHandle(h), get: async (id: string) => AGENTS.find((a) => a.id === id) ?? null,
      forAgent: async (a: any) => ({ agent: a, orchestrator: a, skills: new SkillLibrary(), paused: false }),
      profileOf: async () => null, channelKeyOf: async (a: any) => `@${a.handle}`, agentsSummary: async () => '', managerDigest: async () => null,
      handles: async () => AGENTS.map((a) => a.handle), actionsForChat: async () => [],
    } as any,
  });
  return { svc, llm, messages, bound };
}

test('three agents answer in turn, each with its own stored message; a later one reads the earlier answers', async () => {
  const s = setup([{ text: 'ai_global: переплановую.' }, { text: 'loko: зроблю.' }, { text: 'nova: готово.' }]);
  const events: ChatStreamEvent[] = [];
  await s.svc.sendMessage('c1', '@ai_global @loko_games @nova_planner переплануйте завтра', { onEvent: (e) => events.push(e) });
  const answers = s.messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(answers.map((m) => [m.agentId, m.content]), [
    ['a-ai_global', 'ai_global: переплановую.'], ['a-loko_games', 'loko: зроблю.'], ['a-nova_dev', 'nova: готово.'],
  ], 'a role resolves to its orchestrator');
  const addr = events.find((e) => e.type === 'addressees') as any;
  assert.deepEqual(addr.agents.map((a: any) => a.handle), ['ai_global', 'loko_games', 'nova_dev']);
  assert.deepEqual(events.filter((e) => e.type === 'agent').map((e: any) => e.agent.handle), ['ai_global', 'loko_games', 'nova_dev']);
  const sys2 = String((s.llm.requests[1].messages[0] as any).content);
  assert.match(sys2, /Ти — @loko_games/);
  assert.match(sys2, /Уже відповіли в цьому ході:\n@ai_global: ai_global: переплановую\./);
  assert.deepEqual(s.bound.at(-1), 'a-nova_dev');
});

test('one shared turn cap: agents left out are named in a final note', async () => {
  const s = setup([{ text: 'перший', cost: 0.07 }, { text: 'другий', cost: 0.07 }, { text: 'третій' }], { EDITOR_CHAT_TURN_MAX_USD: '0.15' });
  const r = await s.svc.sendMessage('c1', '@ai_global @loko_games @nova_dev що з планом?');
  assert.equal(s.llm.requests.length, 2);
  assert.match(r.message.content, /^Stopped before @nova_dev — this message reached the per-turn chat cap \(\$0\.15/);
});

test('with @manager among the addressees, @manager coordinates; a single agent mention keeps the old route', async () => {
  const s = setup([{ text: 'Скоординую.' }]);
  await s.svc.sendMessage('c1', '@manager @loko_games @nova_dev узгодьте розклад');
  const answers = s.messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(answers.map((m) => m.agentId), ['a-manager']);
  assert.match(String((s.llm.requests[0].messages[0] as any).content), /ти координуєш/);

  const one = setup([{ text: 'Ок.' }]);
  await one.svc.sendMessage('c1', '@loko_games подивись, як пише @nova_dev');
  assert.deepEqual(one.messages.filter((m) => m.role === 'assistant').map((m) => m.agentId), ['a-loko_games']);
});
