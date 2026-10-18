/** Spec 047 FR-002: the chat's cards and the agent roster in context; denials that contradict them are re-prompted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import type { EditorChatMessage } from '../repo/editor-chat.repository';
import { EditorChatService } from './editor-chat.service';
import { contradictedDenials, denialNote, factsBlock, type ChatFacts } from './chat-facts';
import { emptyTurn } from './turn-record';

const NOW = new Date('2026-10-17T09:00:00Z');
const FACTS: ChatFacts = {
  cards: [
    { id: 'a657a845-0000-4000-8000-000000000001', kind: 'owner_rule', status: 'applied', summary: 'Owner rule for @nova_dev: без хештегів' },
  ],
  handles: ['ai0', 'manager', 'ai_global', 'nova_dev', 'loko_games'],
};

test('the facts block lists the cards with statuses and the roster', () => {
  const b = factsBlock(FACTS)!;
  assert.match(b, /a657a845 owner_rule — застосовано: Owner rule for @nova_dev/);
  assert.match(b, /@nova_dev, @loko_games/);
  assert.match(factsBlock({ cards: [], handles: ['ai0'] })!, /Карток у цьому чаті немає/);
  assert.equal(factsBlock({ cards: [], handles: [] }), null);
});

test('denials that contradict the data: an applied card, a real agent, a tool this turn called', () => {
  const turn = { ...emptyTurn(), tools: ['update_agent'], cards: [{ id: 'p2', kind: 'update_agent' }] };
  const d = contradictedDenials([
    'Нічого не застосовано — картку ви не підтвердили.',
    'Агента @nova_dev не існує, мабуть, ви мали на увазі @nova.',
    'Я не викликав update_agent.',
  ].join(' '), FACTS, turn);
  assert.deepEqual(d.map((x) => x.kind), ['not_applied', 'no_such_agent', 'did_not_call']);
  assert.match(denialNote(d), /card a657a845 \(owner_rule\) is applied; @nova_dev is a real agent; this turn called update_agent/);
});

test('true denials and other words pass: a pending card, an unknown handle, a quote, a tool not called', () => {
  const pending: ChatFacts = { ...FACTS, cards: [...FACTS.cards, { id: 'bbbbbbbb-0000-4000-8000-000000000002', kind: 'write_skill', status: 'pending', summary: 's' }] };
  assert.equal(contradictedDenials('Картку ще не застосовано — натисніть Apply.', pending, emptyTurn()).length, 0, 'the latest card is pending');
  assert.equal(contradictedDenials('Картку a657a845 не застосовано.', pending, emptyTurn()).length, 1, 'the named card is applied');
  assert.equal(contradictedDenials('Агента @ghost не існує.', FACTS, emptyTurn()).length, 0);
  assert.equal(contradictedDenials('Ви написали «нічого не застосовано», але це не так.', FACTS, emptyTurn()).length, 0);
  assert.equal(contradictedDenials('Я не викликав set_brief.', FACTS, { ...emptyTurn(), tools: ['list_agents'] }).length, 0);
});

function setup(turns: ConstructorParameters<typeof FakeLlm>[0]) {
  const messages: EditorChatMessage[] = [];
  const repo: any = {
    createChat: async () => ({ id: 'c1' }), listChats: async () => [], deleteChat: async () => true, touchChat: async () => {},
    getChat: async () => ({ id: 'c1', title: 't', createdAt: NOW, updatedAt: NOW }),
    addMessage: async (m: any) => {
      const row = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: m.draftIds ?? [], runId: null, agentId: m.agentId ?? null, actions: m.actions ?? null, createdAt: NOW };
      messages.push(row);
      return row;
    },
    listMessages: async () => [...messages], listDrafts: async () => [], myChannels: async () => [],
  };
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const ai0: any = { id: 'a-ai0', handle: 'ai0', name: 'ai0', kind: 'builder', scope: 'network', scopeId: null, mode: 'live', status: 'active' };
  const svc = new EditorChatService({
    repo, drafts: { resolveCard: async () => ({ card: makeCard({ channelKey: '@chan' }), hasCard: true }) } as any,
    memory: { listActive: async () => [] }, loop, registry: new ToolRegistry([]), skills: new SkillLibrary(),
    env: () => undefined, enabled: () => true, now: () => NOW,
    agents: {
      byHandle: async (h: string) => (h === 'ai0' ? ai0 : null), get: async () => ai0,
      forAgent: async () => ({ agent: ai0, orchestrator: null, skills: new SkillLibrary(), paused: false }),
      profileOf: async () => null, channelKeyOf: async () => null, agentsSummary: async () => '', handles: async () => FACTS.handles,
      actionsForChat: async () => FACTS.cards as any,
    } as any,
  });
  return { svc, llm };
}

test('replay of review 1 msg 124: «нічого не застосовано» with card a657a845 applied → one re-prompt; the corrected reply stands', async () => {
  const s = setup([
    { text: 'Нічого не застосовано: правило не записане.' },
    { text: 'Виправляю: картку a657a845 застосовано, правило для @nova_dev записане.' },
  ]);
  const r = await s.svc.sendMessage('c1', '@ai0 що з правилом для nova?');
  assert.equal(r.message.content, 'Виправляю: картку a657a845 застосовано, правило для @nova_dev записане.');
  assert.match(String((s.llm.requests[0].messages[0] as any).content), /Агенти мережі \(усі справжні\): @ai0/);
  assert.match((s.llm.requests[1].messages.at(-1) as any).content, /насправді картка a657a845 \(owner_rule\) — застосована/);
});

test('a denial that survives the re-prompt ends with the English note', async () => {
  const s = setup([{ text: 'Такого агента @loko_games немає.' }, { text: 'Такого агента @loko_games немає, перевірте.' }]);
  const r = await s.svc.sendMessage('c1', '@ai0 а @loko_games?');
  assert.equal(r.message.content, 'Такого агента @loko_games немає, перевірте.\n\n(Check: the data says otherwise — @loko_games is a real agent.)');
  assert.equal(s.llm.requests.length, 2, 'one re-prompt only');
});
