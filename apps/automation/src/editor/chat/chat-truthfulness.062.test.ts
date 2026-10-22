/**
 * Spec 062 T1: chat truthfulness, replayed on chat e8c11647 (@ai0_prompts_dev, review 3 findings 5 and 19): a model-typed
 * «[дії: немає — …]» footer read as a denial, the retry had no tool context, and read-only turns showed in the history
 * as «нічого не змінили».
 */
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
import { contradictedDenials, type ChatFacts } from './chat-facts';
import { actionLine, emptyTurn, stripSystemFooters, traceText, TurnRecorder } from './turn-record';
import { NO_SYSTEM_FOOTERS_RULE } from './chat-format';
import { buildComposerSystemPrompt } from '../roles/prompts';

const NOW = new Date('2026-10-18T09:00:00Z');
/** The last card of chat e8c11647: an applied skill card, unrelated to the post the owner asked about. */
const FACTS: ChatFacts = {
  cards: [{ id: '9c1d44e0-0000-4000-8000-000000000001', kind: 'write_skill', status: 'applied', summary: 'Skill for @ai0_prompts_dev' }],
  handles: ['ai0', 'ai0_prompts_dev'],
};

// ── FR-001 ──────────────────────────────────────────────────────────────────

test('stripSystemFooters cuts trailing [дії]/[чернетки]/[actions] blocks and a leading @handle:', () => {
  assert.equal(stripSystemFooters('Готово.\n\n[дії: немає — нічого не збережено й не опубліковано]'), 'Готово.');
  assert.equal(stripSystemFooters('Готово.\n\n[чернетки: d1 · @chan · text]\n[дії: картка write_skill aaaaaaaa]'), 'Готово.');
  assert.equal(stripSystemFooters('Done. [actions: none]'), 'Done.');
  assert.equal(stripSystemFooters('@ai0_prompts_dev: Ось дані.'), 'Ось дані.');
  assert.equal(stripSystemFooters('  @ai0_prompts_dev:\n[дії: немає]'), '', 'a footer-only text is empty');
  // Only the end and the start are the system's.
  assert.equal(stripSystemFooters('У тексті [дії: це приклад] ще слова.'), 'У тексті [дії: це приклад] ще слова.');
  assert.equal(stripSystemFooters('Пишу до @kira: так.'), 'Пишу до @kira: так.');
});

test('every chat prompt tells the model not to write the system lines', () => {
  const p = buildComposerSystemPrompt({ now: NOW, card: null, hasCard: false, memory: [], skills: new SkillLibrary() });
  assert.ok(p.includes(NO_SYSTEM_FOOTERS_RULE));
  assert.match(NO_SYSTEM_FOOTERS_RULE, /\[дії: …\], \[чернетки: …\] чи «@handle:» — їх додає система/);
});

// ── FR-002 ──────────────────────────────────────────────────────────────────

test('the history line names the tools: read-only turns, writing turns, no tools, legacy records', () => {
  const read = { ...emptyTurn(), tools: ['library_catalog', 'sql_readonly', 'library_catalog'] };
  assert.equal(actionLine(read), '[дії: змін немає; викликано: library_catalog, sql_readonly]');
  const wrote = { ...emptyTurn(), cards: [{ id: 'aaaaaaaa-1111', kind: 'write_skill' }], tools: ['edit_my_skill'] };
  assert.equal(actionLine(wrote, () => 'applied'), '[дії: картка write_skill aaaaaaaa (застосовано); викликано: edit_my_skill]');
  assert.equal(actionLine(emptyTurn()), '[дії: інструменти не викликались]');
  assert.equal(actionLine({ cards: [], rules: [], drafts: [], skills: [] } as any), '[дії: змін немає]', 'a record from before tools were kept');
  const many = { ...emptyTurn(), tools: Array.from({ length: 13 }, (_, i) => `tool_${i}`) };
  assert.match(actionLine(many)!, /викликано: tool_0, .*, tool_9 та ще 3\]$/);
});

// ── FR-003 ──────────────────────────────────────────────────────────────────

test('the latest card stands in for a denial only when the sentence is about a card', () => {
  const none = emptyTurn();
  // A sentence about a draft or a post is not a card denial.
  assert.equal(contradictedDenials('Чернетку не збережено, бо ви не просили.', FACTS, none).length, 0);
  assert.equal(contradictedDenials('Нічого не збережено й не опубліковано.', FACTS, none).length, 0);
  // A card sentence still is.
  assert.equal(contradictedDenials('Картку не застосовано.', FACTS, none).length, 1);
  assert.equal(contradictedDenials('The card was not applied.', FACTS, none).length, 1);
  assert.equal(contradictedDenials('Нічого не застосовано — натисніть Apply.', FACTS, none).length, 1);
  assert.equal(contradictedDenials('Не застосовано 9c1d44e0.', FACTS, none).length, 1, 'a card id names the card');
});

test('«I called no tools» is caught after reads, named or not, written or not', () => {
  const reads = { ...emptyTurn(), tools: ['library_catalog', 'sql_readonly'] };
  const kinds = (t: string, turn = reads) => contradictedDenials(t, FACTS, turn).map((d) => d.kind);
  assert.deepEqual(kinds('Я не викликав інструментів у тому ході.'), ['did_not_call']);
  assert.deepEqual(kinds('Попередні відповіді я нічого не перевіряв інструментами.'), ['did_not_call']);
  assert.deepEqual(kinds('Жодного інструмента я не викликав.'), ['did_not_call']);
  assert.deepEqual(kinds('I did not call any tools.'), ['did_not_call']);
  assert.deepEqual(kinds('Я не викликав sql_readonly.'), ['did_not_call'], 'a named tool the turn called');
  assert.deepEqual(kinds('Я не викликав set_brief.'), [], 'a named tool the turn did not call');
  assert.deepEqual(kinds('Я не викликав інструментів запису.'), [], 'true after reads only');
  assert.deepEqual(kinds('Я не викликав інструментів запису.', { ...reads, drafts: ['d1'] }), ['did_not_call'], 'untrue after a save');
  assert.deepEqual(kinds('Я не викликав інструментів.', emptyTurn()), [], 'a turn with no tools at all');
  const d = contradictedDenials('Я не викликав інструментів.', FACTS, reads)[0];
  assert.match(d.evidence, /цей хід викликав: library_catalog, sql_readonly/);
});

test('the trace is one line per call and fits its budget', async () => {
  const rec = new TurnRecorder();
  const tools = rec.wrap([
    defineTool({ name: 'library_catalog', description: 'l', kind: 'read', roles: ['composer'], input: z.object({}), execute: async () => ({ ok: true, fields: ['title', 'media_url'] }) }),
    defineTool({ name: 'sql_readonly', description: 's', kind: 'read', roles: ['composer'], input: z.object({}), execute: async () => ({ error: 'bad_sql', details: 'syntax error' }) }),
  ]);
  await tools[0].execute({}, {} as any);
  await tools[1].execute({}, {} as any);
  assert.equal(traceText(rec.trace), '- library_catalog: {"ok":true,"fields":["title","media_url"]}\n- sql_readonly: error: bad_sql syntax error');
  assert.deepEqual(rec.turn.tools, ['library_catalog'], 'the stored record keeps successful calls only');
  const long = Array.from({ length: 40 }, (_, i) => ({ tool: `tool_${i}`, result: 'x'.repeat(100) }));
  const t = traceText(long, 500);
  assert.ok(t.length <= 560, String(t.length));
  assert.match(t, /… ще \d+ викликів$/);
});

// ── replay of chat e8c11647 ─────────────────────────────────────────────────

function setup(turns: ConstructorParameters<typeof FakeLlm>[0], prior: EditorChatMessage[] = [], facts: ChatFacts = FACTS) {
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
  const read = (name: string, out: unknown) => defineTool({ name, description: name, kind: 'read', roles: ['composer'], input: z.object({}).passthrough(), execute: async () => out });
  const registry = new ToolRegistry([
    read('library_catalog', { sources: [{ name: 'prompts', fields: ['title', 'prompt_text'] }] }),
    read('query_data', { rows: [{ title: 'Neon cat' }] }),
    read('sql_readonly', { rows: [{ n: 3 }] }),
  ]);
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const bot: any = { id: 'a-bot', handle: 'ai0_prompts_dev', name: 'Prompts', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', mode: 'live', status: 'active' };
  const svc = new EditorChatService({
    repo, drafts: { resolveCard: async () => ({ card: makeCard({ channelKey: '@chan' }), hasCard: true }) } as any,
    memory: { listActive: async () => [] }, loop, registry, skills: new SkillLibrary(),
    env: () => undefined, enabled: () => true, now: () => NOW,
    agents: {
      byHandle: async (h: string) => (h === 'ai0_prompts_dev' ? bot : null), get: async (id: string) => (id === 'a-bot' ? bot : null),
      forAgent: async () => ({ agent: bot, orchestrator: bot, skills: new SkillLibrary(), paused: false }),
      profileOf: async () => null, channelKeyOf: async () => '@chan', agentsSummary: async () => '', handles: async () => facts.handles,
      actionsForChat: async () => facts.cards as any,
    },
  });
  return { svc, llm, stored };
}

const ASK = '@ai0_prompts_dev скільки промптів у бібліотеці?';
const THREE_READS = [
  { calls: [{ name: 'library_catalog', args: {} }, { name: 'query_data', args: {} }, { name: 'sql_readonly', args: {} }] },
];

test('replay 4e4d4e82: a model-typed «[дії: немає — …]» footer is cut — no false denial, no retry', async () => {
  const s = setup([
    ...THREE_READS,
    { text: '@ai0_prompts_dev: У бібліотеці 3 промпти.\n\n[дії: немає — нічого не збережено й не опубліковано]' },
  ]);
  const r = await s.svc.sendMessage('c1', ASK);
  assert.equal(r.message.content, 'У бібліотеці 3 промпти.');
  assert.equal(s.llm.requests.length, 2, 'one tool turn and one answer: no retry');
  assert.equal(s.stored.at(-1).actions.retried_from, undefined);
  assert.deepEqual(s.stored.at(-1).actions.tools, ['library_catalog', 'query_data', 'sql_readonly']);
});

test('replay: the next turn reads which tools the read-only turn called', async () => {
  const first = setup([...THREE_READS, { text: 'У бібліотеці 3 промпти.' }]);
  await first.svc.sendMessage('c1', ASK);
  const prior: EditorChatMessage[] = [
    { id: 1, chatId: 'c1', role: 'user', content: ASK, draftIds: [], runId: null, agentId: 'a-bot', createdAt: NOW },
    { id: 2, chatId: 'c1', role: 'assistant', content: 'У бібліотеці 3 промпти.', draftIds: [], runId: 'run-1', agentId: 'a-bot', createdAt: NOW, actions: first.stored.at(-1).actions },
  ];
  const s = setup([{ text: 'Так, я перевіряв.' }], prior);
  await s.svc.sendMessage('c1', '@ai0_prompts_dev ти це перевіряв?');
  const msgs = s.llm.requests[0].messages as any[];
  assert.equal(msgs[2].content, '@ai0_prompts_dev: У бібліотеці 3 промпти.\n\n[дії: змін немає; викликано: library_catalog, query_data, sql_readonly]');
});

test('replay: a generic «я нічого не перевіряв інструментами» after reads keeps the answer and appends the note — no second run', async () => {
  const s = setup([
    ...THREE_READS,
    { text: 'Відповіді вище я нічого не перевіряв інструментами, тож не довіряйте їм.' },
  ]);
  const r = await s.svc.sendMessage('c1', ASK);
  assert.equal(
    r.message.content,
    'Відповіді вище я нічого не перевіряв інструментами, тож не довіряйте їм.\n\n(Check: the data says otherwise — this turn called library_catalog, query_data, sql_readonly.)',
  );
  assert.equal(s.llm.requests.length, 2, 'no retry for a denial the tools already contradict');
});

test('replay: a denied card is re-run with the first run’s tool trace, and the stored message points at the first run', async () => {
  const s = setup([
    ...THREE_READS,
    { text: 'Нічого не застосовано: картку так і не підтверджено.' },
    { text: 'Вибачте: картка 9c1d44e0 застосована; у бібліотеці 3 промпти.' },
  ]);
  const r = await s.svc.sendMessage('c1', ASK);
  assert.equal(r.message.content, 'Вибачте: картка 9c1d44e0 застосована; у бібліотеці 3 промпти.');
  assert.equal(s.llm.requests.length, 3);
  const retry = String((s.llm.requests[2].messages.at(-1) as any).content);
  assert.match(retry, /насправді картка 9c1d44e0 \(write_skill\) — застосована/);
  assert.match(retry, /Інструменти, які ти викликав у цьому ході/);
  assert.match(retry, /- library_catalog: \{"sources"/);
  assert.match(retry, /- sql_readonly: \{"rows":\[\{"n":3\}\]\}/);
  const actions = s.stored.at(-1).actions;
  assert.equal(actions.retried_from, 'run-1');
  assert.deepEqual(actions.tools.slice(0, 3), ['library_catalog', 'query_data', 'sql_readonly']);
});

test('replay: a sentence about a draft after reads no longer falls back to the unrelated last card', async () => {
  const s = setup([
    ...THREE_READS,
    { text: 'Чернетку не збережено: ви лише питали про кількість.' },
  ]);
  const r = await s.svc.sendMessage('c1', ASK);
  assert.equal(r.message.content, 'Чернетку не збережено: ви лише питали про кількість.');
  assert.equal(s.llm.requests.length, 2, 'no retry');
});
