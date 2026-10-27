/**
 * Spec 069 FR-006: the claim guard knows the chat's past. Review 4 (chat export, msg 194): an answer that restated an
 * applied write_skill card («я записав скіл…») was called a false claim, re-run with its own answer in the history, and the
 * model apologised: «Я виправляю відповідь… Що було не так у моїй відповіді».
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
import { EditorChatService, pastOf } from './editor-chat.service';
import { ChatReadCapture } from './chat-reads';
import { backedByPast, claimedActions, claimRetryUser, emptyTurn, NOT_DONE_NOTE, TurnRecorder, unbackedClaims, type ChatPast } from './turn-record';

const NOW = new Date('2026-10-27T09:00:00Z');
const SKILL_CARD = { id: 'f6910856-0000-4000-8000-000000000001', kind: 'write_skill', status: 'applied', summary: 'Skill "nanobanana-prompts" for @kira: How the channel takes its prompts' };

// ── what counts as a write claim ────────────────────────────────────────────

test('a rule verb on a skill, a post or a draft is a write claim; with the word «правило» it stays a rule claim', () => {
  const kinds = (t: string) => claimedActions(t).map((c) => c.kind);
  assert.deepEqual(kinds('Я записав скіл nanobanana-prompts.'), ['write']);
  assert.deepEqual(kinds('Записала скіл і оновила бриф.'), ['write']);
  assert.deepEqual(kinds('Зберіг чернетку поста.'), ['write']);
  assert.deepEqual(kinds('Створив пост у чернетках.'), ['write']);
  assert.deepEqual(kinds('Created the skill.'), ['write']);
  assert.deepEqual(kinds('Записав правило про пости: без хештегів.'), ['rule']);
  assert.deepEqual(kinds('Записав правило: без мемів.'), ['rule']);
  assert.deepEqual(kinds('Створив для вас пояснення.'), [], '«створив» alone is not a claim of a write');
  assert.deepEqual(kinds('Не створив скіл — потрібне ваше підтвердження.'), [], 'negated');
  assert.deepEqual(kinds('Вчора я записав скіл.'), [], 'an earlier turn');
});

test('the claim keeps its quoted words for the backing check and still drops them for the guards', () => {
  const [c] = claimedActions('Я записав скіл «nanobanana-prompts». Далі — ваш хід.');
  assert.equal(c.kind, 'write');
  assert.equal(c.sentence, 'Я записав скіл .');
  assert.match(c.full, /«nanobanana-prompts»/);
});

// ── backing from the chat's past ────────────────────────────────────────────

const past = (over: Partial<ChatPast> = {}): ChatPast => ({ turns: [], cards: [SKILL_CARD], ...over });

test('«я записав скіл X» is backed by an applied write_skill card that names X — not by free words', () => {
  const none = emptyTurn();
  assert.equal(unbackedClaims('Я записав скіл nanobanana-prompts.', none, past()).length, 0);
  assert.equal(unbackedClaims('Я записав скіл «nanobanana-prompts» для каналу.', none, past()).length, 0, 'in quotes too');
  assert.equal(unbackedClaims('Я записав скіл NanoBanana-Prompts.', none, past()).length, 0, 'case does not matter');
  assert.equal(unbackedClaims('Я записав скіл.', none, past()).length, 1, 'names nothing');
  assert.equal(unbackedClaims('Я записав скіл про промпти для каналу.', none, past()).length, 1, 'free-word overlap is not enough');
  assert.equal(unbackedClaims('Я записав скіл nanobanana.', none, past()).length, 1, 'a part of the handle is not the handle');
  assert.equal(unbackedClaims('Я записав скіл nanobanana-prompts.', none).length, 1, 'without the past it is unbacked');
});

test('a card id, a rule number, a draft id and a skill of an earlier turn back a claim; a pending or discarded card does not back «applied»', () => {
  const none = emptyTurn();
  assert.equal(unbackedClaims('Застосовано картку f6910856.', none, past()).length, 0);
  assert.equal(unbackedClaims('Застосовано картку f6910856.', none, past({ cards: [{ ...SKILL_CARD, status: 'pending' }] })).length, 1);
  assert.equal(unbackedClaims('Застосовано картку f6910856.', none, past({ cards: [{ ...SKILL_CARD, status: 'discarded' }] })).length, 1);
  assert.equal(unbackedClaims('Надіслав картку f6910856.', none, past({ cards: [{ ...SKILL_CARD, status: 'pending' }] })).length, 0, 'sent is true while it waits');
  assert.equal(unbackedClaims('Записав правило #12: без мемів.', none, past({ turns: [{ ...emptyTurn(), rules: [12] }] })).length, 0);
  assert.equal(unbackedClaims('Записав правило #13: без мемів.', none, past({ turns: [{ ...emptyTurn(), rules: [12] }] })).length, 1);
  assert.equal(unbackedClaims('Зберіг чернетку 1a2b3c4d.', none, past({ turns: [{ ...emptyTurn(), drafts: ['1a2b3c4d-5e6f-4000-8000-000000000000'] }] })).length, 0);
  assert.equal(unbackedClaims('Оновив скіл loko-guide.', none, past({ cards: [], turns: [{ ...emptyTurn(), skills: ['loko-guide v3'] }] })).length, 0);
  assert.equal(unbackedClaims('Оновив скіл loko-guide.', none, past({ cards: [], turns: [{ ...emptyTurn(), cards: [{ id: 'aaaaaaaa-1', kind: 'write_skill' }] }] })).length, 1);
  // The helper itself: a claim of this turn is judged by the turn first.
  assert.equal(backedByPast({ kind: 'write', full: 'Я записав скіл nanobanana-prompts.' }, past()), true);
});

test('pastOf takes the stored actions of the assistant messages and the chat facts cards', () => {
  const rows = [
    { role: 'user', actions: null }, { role: 'assistant', actions: { ...emptyTurn(), rules: [4] } }, { role: 'assistant', actions: null },
  ] as any;
  const p = pastOf(rows, { cards: [SKILL_CARD] as any, handles: [] });
  assert.deepEqual(p.turns.map((t) => t.rules), [[4]]);
  assert.deepEqual(p.cards.map((c) => [c.id, c.status]), [[SKILL_CARD.id, 'applied']]);
  assert.deepEqual(pastOf([], null), { turns: [], cards: [] });
});

// ── the retry ───────────────────────────────────────────────────────────────

function setup(turns: ConstructorParameters<typeof FakeLlm>[0], o: { prior?: EditorChatMessage[]; cards?: any[]; reads?: ChatReadCapture } = {}) {
  const messages: EditorChatMessage[] = [...(o.prior ?? [])];
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
  const rules: string[] = [];
  const addRule = defineTool({
    name: 'add_owner_rule', description: 'rule', kind: 'act', roles: ['composer'], input: z.object({ text: z.string() }),
    execute: async ({ text }) => { rules.push(text); return { ok: true, id: 41 }; },
  });
  const catalog = defineTool({ name: 'library_catalog', description: 'c', kind: 'read', roles: ['composer'], input: z.object({}), execute: async () => ({ ok: true }) });
  const fetchPage = defineTool({
    name: 'web_fetch', description: 'w', kind: 'read', roles: ['composer'], input: z.object({ url: z.string() }),
    execute: async ({ url }) => ({ url, title: 'Ring', text: 'Page text about the Ring nebula.' }),
  });
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const kira: any = { id: 'a-kira', handle: 'kira', name: 'Kira', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', mode: 'live', status: 'active' };
  const svc = new EditorChatService({
    repo, drafts: { resolveCard: async () => ({ card: makeCard({ channelKey: '@chan' }), hasCard: true }) } as any,
    memory: { listActive: async () => [] }, loop, registry: new ToolRegistry([addRule, catalog, fetchPage]), skills: new SkillLibrary(),
    env: () => undefined, enabled: () => true, now: () => NOW, ...(o.reads ? { chatReads: o.reads } : {}),
    agents: {
      byHandle: async (h: string) => (h === 'kira' ? kira : null), get: async (id: string) => (id === 'a-kira' ? kira : null),
      forAgent: async () => ({ agent: kira, orchestrator: kira, skills: new SkillLibrary(), paused: false }),
      profileOf: async () => null, channelKeyOf: async () => '@chan', agentsSummary: async () => '', handles: async () => ['kira'],
      actionsForChat: async () => o.cards ?? [],
    },
  });
  return { svc, llm, stored, rules };
}

const roles = (req: any) => (req.messages as any[]).map((m) => m.role);

test('«я записав скіл X» after an applied write_skill card that names X: no retry, the answer stands', async () => {
  const s = setup([{ text: 'Так, я записав скіл nanobanana-prompts — він уже застосований.' }], { cards: [SKILL_CARD] });
  const r = await s.svc.sendMessage('c1', '@kira що з тим скілом?');
  assert.equal(r.message.content, 'Так, я записав скіл nanobanana-prompts — він уже застосований.');
  assert.equal(s.llm.requests.length, 1, 'no second run');
  assert.equal(s.stored.at(-1).actions.retried_from, undefined);
});

test('a claim that names nothing is re-run WITHOUT the first answer; the final text has no «виправляю»', async () => {
  const prior: EditorChatMessage[] = [
    { id: 1, chatId: 'c1', role: 'user', content: '@kira привіт', draftIds: [], runId: null, agentId: 'a-kira', createdAt: NOW },
    { id: 2, chatId: 'c1', role: 'assistant', content: 'Привіт!', draftIds: [], runId: null, agentId: 'a-kira', createdAt: NOW, actions: { ...emptyTurn(), tools: [] } },
  ];
  const s = setup([
    { text: 'Я записав скіл, як ви просили.' },
    { text: 'Скіл ще не записано: потрібна ваша згода. Нічого не змінено.' },
  ], { prior, cards: [SKILL_CARD] });
  const r = await s.svc.sendMessage('c1', '@kira запиши скіл про промпти');
  assert.equal(s.llm.requests.length, 2);
  const retry = s.llm.requests[1].messages as any[];
  assert.ok(!retry.some((m) => /Я записав скіл, як ви просили/.test(String(m.content))), 'the first answer is not in the retry');
  assert.deepEqual(roles(s.llm.requests[1]).filter((x: string) => x !== 'system'), ['user', 'assistant', 'user'], 'the earlier history plus the owner message once');
  const last = String(retry.at(-1).content);
  assert.match(last, /^@kira запиши скіл про промпти\n\n\[Системна примітка: відповідай на останнє повідомлення власника ще раз/);
  assert.match(last, /ніколи не згадуй перевірку чи виправлення/);
  assert.doesNotMatch(r.message.content, /виправля/i);
  assert.equal(r.message.content, 'Скіл ще не записано: потрібна ваша згода. Нічого не змінено.');
  assert.equal(s.stored.at(-1).actions.retried_from, 'run-1');
});

test('the retry lists the calls this turn already made and tells the model not to repeat them', async () => {
  const s = setup([
    { calls: [{ name: 'library_catalog', args: {} }] },
    { text: 'Надіслав картку на скіл.' },
    { text: 'Я лише переглянув каталог бібліотеки; нічого не змінено.' },
  ]);
  await s.svc.sendMessage('c1', '@kira зроби скіл');
  const last = String((s.llm.requests[2].messages as any[]).at(-1).content);
  assert.match(last, /Ці виклики вже виконано в цьому ході — не повторюй їх:\n- library_catalog: \{"ok":true\}\]$/);
});

test('a claim and a denial together: the claim shape, with the denial text appended', async () => {
  const s = setup([
    { text: 'Нічого не застосовано: картку 9c1d44e0 так і не підтверджено. Надіслав картку про правило.' },
    { text: 'Картка 9c1d44e0 застосована; нових карток не надсилав.' },
  ], { cards: [{ id: '9c1d44e0-0000-4000-8000-000000000002', kind: 'write_skill', status: 'applied', summary: 'Skill "x-skill" for @kira' }] });
  const r = await s.svc.sendMessage('c1', '@kira що з карткою?');
  assert.equal(s.llm.requests.length, 2);
  const retry = s.llm.requests[1].messages as any[];
  assert.ok(!retry.some((m) => m.role === 'assistant' && /Нічого не застосовано/.test(String(m.content))), 'claim shape: no first answer in the history');
  const last = String(retry.at(-1).content);
  assert.match(last, /^@kira що з карткою\?\n\n\[Системна примітка: /);
  assert.match(last, /насправді картка 9c1d44e0 \(write_skill\) — застосована/);
  assert.equal(r.message.content, 'Картка 9c1d44e0 застосована; нових карток не надсилав.');
});

test('a retry after add_owner_rule does not store the rule twice', async () => {
  const s = setup([
    { calls: [{ name: 'add_owner_rule', args: { text: 'Без хештегів' } }] },
    { text: 'Надіслав картку про правило.' },                                   // an unbacked claim: no card was made
    { calls: [{ name: 'add_owner_rule', args: { text: 'Без хештегів' } }] },   // the retry repeats the call
    { text: 'Правило #41 записано: без хештегів.' },
  ]);
  const r = await s.svc.sendMessage('c1', '@kira запамʼятай: без хештегів');
  assert.deepEqual(s.rules, ['Без хештегів'], 'stored once');
  assert.equal(s.llm.requests.length, 4);
  // The retry's own add_owner_rule call was answered from the first run, not executed.
  const toolAnswer = (s.llm.requests[3].messages as any[]).filter((m) => m.role === 'tool').at(-1);
  assert.match(String(toolAnswer.content), /already_done/);
  assert.match(String(toolAnswer.content), /"id":41/);
  assert.match(String((s.llm.requests[2].messages as any[]).at(-1).content), /- add_owner_rule: \{"ok":true,"id":41\}/);
  assert.equal(r.message.content, 'Правило #41 записано: без хештегів.');
  assert.deepEqual(s.stored.at(-1).actions.rules, [41], 'one rule in the turn record');
  assert.equal(s.stored.at(-1).actions.tools.filter((t: string) => t === 'add_owner_rule').length, 1, 'recorded once');
});

test('a chat turn keeps what its read tools returned in the chat capture (spec 069 FR-007)', async () => {
  const reads = new ChatReadCapture();
  const s = setup([
    { calls: [{ name: 'web_fetch', args: { url: 'https://nasa.gov/ring' } }] },
    { text: 'Прочитав сторінку.' },
  ], { reads });
  await s.svc.sendMessage('c1', '@kira що там на сторінці?');
  assert.deepEqual(reads.sourcesFor('c1').map((x) => [x.url, x.text]), [['https://nasa.gov/ring', 'Ring\nPage text about the Ring nebula.']]);
  assert.deepEqual(reads.sourcesFor('c2'), [], 'another chat sees nothing');
});

test('a reply that still claims after the retry gets the visible note', async () => {
  const s = setup([{ text: 'Я записав скіл.' }, { text: 'Так, я записав скіл.' }]);
  const r = await s.svc.sendMessage('c1', '@kira запиши скіл');
  assert.equal(r.message.content, `Так, я записав скіл.\n\n${NOT_DONE_NOTE}`);
  assert.equal(s.llm.requests.length, 2, 'one retry only');
});

// ── the recorder's replay guard, directly ───────────────────────────────────

test('replay: only act and terminal calls that succeeded are answered from the first run; reads and failures run again', async () => {
  const calls: string[] = [];
  const act = defineTool({ name: 'act_tool', description: 'a', kind: 'act', roles: ['composer'], input: z.object({ n: z.number() }), execute: async ({ n }) => { calls.push(`act${n}`); return { ok: true, n }; } });
  const read = defineTool({ name: 'read_tool', description: 'r', kind: 'read', roles: ['composer'], input: z.object({}), execute: async () => { calls.push('read'); return { ok: true }; } });
  const flaky = defineTool({ name: 'flaky_tool', description: 'f', kind: 'act', roles: ['composer'], input: z.object({}), execute: async () => { calls.push('flaky'); return { error: 'nope' }; } });
  const rec = new TurnRecorder();
  const [a, r, f] = rec.wrap([act, read, flaky]);
  await a.execute({ n: 1 }, {} as any); await r.execute({}, {} as any); await f.execute({}, {} as any);
  rec.replay();
  const again: any = await a.execute({ n: 1 }, {} as any);
  assert.equal(again.n, 1);
  assert.ok(again.already_done);
  await a.execute({ n: 2 }, {} as any);               // other input: a real call
  await r.execute({}, {} as any); await f.execute({}, {} as any);
  assert.deepEqual(calls, ['act1', 'read', 'flaky', 'act2', 'read', 'flaky']);
  assert.deepEqual(rec.turn.tools, ['act_tool', 'read_tool', 'act_tool', 'read_tool'], 'a replayed call is not recorded again');
  // The same input in another key order is the same call.
  const act2 = defineTool({ name: 'act_two', description: 'a', kind: 'act', roles: ['composer'], input: z.object({ a: z.number(), b: z.number() }), execute: async () => { calls.push('two'); return { ok: true }; } });
  const rec2 = new TurnRecorder();
  const [t] = rec2.wrap([act2]);
  await t.execute({ a: 1, b: 2 }, {} as any);
  rec2.replay();
  await t.execute({ b: 2, a: 1 }, {} as any);
  assert.equal(calls.filter((c) => c === 'two').length, 1);
});

test('claimRetryUser: the owner message, the note, and the trace only when there is one', () => {
  assert.equal(claimRetryUser('Привіт', ''), 'Привіт\n\n[Системна примітка: відповідай на останнє повідомлення власника ще раз; кажи лише те, що зробили інструменти; ніколи не згадуй перевірку чи виправлення.]');
  assert.match(claimRetryUser('Привіт', '- a: ok'), /Ці виклики вже виконано в цьому ході — не повторюй їх:\n- a: ok\]$/);
});
