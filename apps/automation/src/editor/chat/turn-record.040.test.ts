import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { defineTool } from '../harness/tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import type { EditorChatMessage } from '../repo/editor-chat.repository';
import { EditorChatService } from './editor-chat.service';
import { actionLine, claimedActions, emptyTurn, historyTurn, NOT_DONE_NOTE, TurnRecorder, unbackedClaims } from './turn-record';

/** Spec 040 FR-014: truthful history — authors, the action line per turn, the claim guard. */

test('the recorder keeps what the tools did: cards, stored rules, drafts, skills; errors and unstored rules are not actions', async () => {
  const rec = new TurnRecorder();
  rec.record('add_owner_rule', { text: 'Без хештегів' }, { ok: true, id: 12 });
  rec.record('add_owner_rule', { text: 'x' }, { ok: true, pending_action: 'pa-rule-0001', stored: false });
  rec.record('add_owner_rule', { text: 'y' }, { error: 'unknown_skill' });
  rec.record('propose_skill_edit', { skill: 'loko-guide' }, { ok: true, skill: 'loko-guide', version: 3 });
  rec.record('save_draft', {}, { ok: true, draft: { id: 'd-1234567890' } });
  rec.card('pa-rule-0001', 'owner_rule');
  rec.draft('d-1234567890');
  assert.deepEqual(rec.turn, {
    cards: [{ id: 'pa-rule-0001', kind: 'owner_rule' }], rules: [12], drafts: ['d-1234567890'], skills: ['loko-guide v3'],
    tools: ['add_owner_rule', 'add_owner_rule', 'propose_skill_edit', 'save_draft'],
  });
  const wrapped = rec.wrap([defineTool({ name: 'lint', description: 'l', kind: 'read', roles: ['composer'], input: z.object({}), execute: async () => ({ ok: true }) })]);
  assert.deepEqual(await wrapped[0].execute({}, {} as any), { ok: true });
  assert.equal(rec.turn.tools.at(-1), 'lint');
});

test('the action line shows the cards with their status now; a turn without changes says so', () => {
  const t = { ...emptyTurn(), cards: [{ id: 'aaaaaaaa-1111', kind: 'write_skill' }], rules: [12] };
  assert.equal(actionLine(t, (id) => (id === 'aaaaaaaa-1111' ? 'applied' : undefined)), '[дії: картка write_skill aaaaaaaa (застосовано); правило #12 записано]');
  assert.equal(actionLine(emptyTurn()), '[дії: інструменти не викликались]');
  assert.equal(actionLine(null), null, 'old messages without a record show no line');
  assert.equal(historyTurn('Готово.', 'kira', '[дії: немає]'), '@kira: Готово.\n\n[дії: немає]');
  assert.equal(historyTurn('Готово.', null, null), 'Готово.');
});

test('claims: what counts, what does not (negated, future, earlier turns, quotes)', () => {
  const kinds = (t: string) => claimedActions(t).map((c) => c.kind);
  assert.deepEqual(kinds('Записав правило: без хештегів.'), ['rule']);
  assert.deepEqual(kinds('Надіслав картку на зміну скіла.'), ['card']);
  assert.deepEqual(kinds('Оновив профіль. Застосовано.'), ['write', 'write']);
  assert.deepEqual(kinds('Saved the rule.'), ['rule']);
  for (const t of ['Не записав — правило суперечить плейбуку.', 'Після Apply буде застосовано.', 'Вчора я записав правило #12.', 'Ти писав: «записав правило».', 'Можу записати правило, якщо хочеш.']) {
    assert.deepEqual(kinds(t), [], t);
  }
});

test('a claim is backed only by the matching action of this turn', () => {
  const none = emptyTurn();
  assert.equal(unbackedClaims('Записав правило.', none).length, 1);
  assert.equal(unbackedClaims('Записав правило.', { ...none, rules: [3] }).length, 0);
  assert.equal(unbackedClaims('Записав правило.', { ...none, cards: [{ id: 'p', kind: 'owner_rule' }] }).length, 0, 'the owner_rule card is the honest path');
  assert.equal(unbackedClaims('Надіслав картку.', { ...none, rules: [3] }).length, 1);
  assert.equal(unbackedClaims('Оновив бриф.', { ...none, cards: [{ id: 'p', kind: 'set_brief' }] }).length, 0);
});

const NOW = new Date('2026-10-16T09:00:00Z');

function setup(turns: ConstructorParameters<typeof FakeLlm>[0], prior: EditorChatMessage[] = []) {
  const messages: EditorChatMessage[] = [...prior];
  const stored: any[] = [];
  const repo: any = {
    createChat: async () => ({ id: 'c1' }), listChats: async () => [], deleteChat: async () => true, touchChat: async () => {},
    getChat: async () => ({ id: 'c1', title: 't', createdAt: NOW, updatedAt: NOW }),
    addMessage: async (m: any) => {
      stored.push(m);
      const row = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: m.draftIds ?? [], runId: m.runId ?? null, agentId: m.agentId ?? null, actions: m.actions ?? null, createdAt: NOW };
      messages.push(row);
      return row;
    },
    listMessages: async () => [...messages], listDrafts: async () => [], myChannels: async () => [{ channelKey: '@chan', title: 'T', hasCard: true, mode: 'shadow' }],
  };
  const rules: any[] = [];
  const addRule = defineTool({
    name: 'add_owner_rule', description: 'rule', kind: 'act', roles: ['composer'], input: z.object({ text: z.string() }),
    execute: async ({ text }) => { rules.push(text); return { ok: true, id: 41 }; },
  });
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const kira: any = { id: 'a-kira', handle: 'kira', name: 'Kira', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', mode: 'live', status: 'active' };
  const svc = new EditorChatService({
    repo, drafts: { resolveCard: async () => ({ card: makeCard({ channelKey: '@chan' }), hasCard: true }) } as any,
    memory: { listActive: async () => [] }, loop, registry: new ToolRegistry([addRule]), skills: new SkillLibrary(),
    env: () => undefined, enabled: () => true, now: () => NOW,
    agents: {
      byHandle: async (h: string) => (h === 'kira' ? kira : null), get: async (id: string) => (id === 'a-kira' ? kira : null),
      forAgent: async () => ({ agent: kira, orchestrator: kira, skills: new SkillLibrary(), paused: false }),
      profileOf: async () => null, channelKeyOf: async () => '@chan', agentsSummary: async () => '', handles: async () => ['kira'],
      actionsForChat: async () => [{ id: 'pa-card-0001', status: 'applied' }] as any,
    },
  });
  return { svc, llm, stored, rules };
}

test('a claim with no tool call gets one re-prompt; a corrected reply is kept without a note', async () => {
  const s = setup([
    { text: 'Записав правило: без хештегів.' },
    { calls: [{ name: 'add_owner_rule', args: { text: 'Без хештегів' } }] },
    { text: 'Тепер записав правило #41: без хештегів.' },
  ]);
  const r = await s.svc.sendMessage('c1', '@kira запамʼятай: без хештегів');
  assert.equal(r.message.content, 'Тепер записав правило #41: без хештегів.');
  assert.deepEqual(s.rules, ['Без хештегів']);
  assert.match((s.llm.requests[1].messages.at(-1) as any).content, /Ти написав, що виконав дію \(«Записав правило: без хештегів\.»\)/);
  assert.deepEqual(s.stored.at(-1).actions.rules, [41]);
});

test('a reply that still claims an action after the re-prompt gets the visible note', async () => {
  const s = setup([{ text: 'Записав правило.' }, { text: 'Так, записав правило.' }]);
  const r = await s.svc.sendMessage('c1', '@kira запамʼятай: без хештегів');
  assert.equal(r.message.content, `Так, записав правило.\n\n${NOT_DONE_NOTE}`);
  assert.equal(s.llm.requests.length, 2, 'one re-prompt only');
  assert.deepEqual(s.stored.at(-1).actions, { ...emptyTurn(), retried_from: 'run-1' });
});

test('the history shows the author and the action line with the card status now', async () => {
  const prior: EditorChatMessage[] = [
    { id: 1, chatId: 'c1', role: 'user', content: '@kira зміни скіл', draftIds: [], runId: null, agentId: 'a-kira', createdAt: NOW },
    { id: 2, chatId: 'c1', role: 'assistant', content: 'Надіслав картку.', draftIds: [], runId: null, agentId: 'a-kira', createdAt: NOW,
      actions: { ...emptyTurn(), cards: [{ id: 'pa-card-0001', kind: 'write_skill' }], tools: ['edit_my_skill'] } },
    { id: 3, chatId: 'c1', role: 'assistant', content: 'Старе повідомлення.', draftIds: [], runId: null, createdAt: NOW },
  ];
  const s = setup([{ text: 'Картка вже застосована.' }], prior);
  await s.svc.sendMessage('c1', '@kira що з карткою?');
  const msgs = s.llm.requests[0].messages as any[];
  assert.equal(msgs[2].content, '@kira: Надіслав картку.\n\n[дії: картка write_skill pa-card- (застосовано); викликано: edit_my_skill]');
  assert.equal(msgs[3].content, 'Старе повідомлення.');
});
