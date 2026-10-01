import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import type { EditorChatMessage } from '../repo/editor-chat.repository';
import { buildComposerTools } from '../chat/composer-tools';
import { EditorChatService, ChatStreamEvent, AgentChatPort } from '../chat/editor-chat.service';
import { hasAgentChangeIntent, parseMentions, ruleOverlap, startsWithMention } from './mentions';
import { renderProfile, ResourceProfileSchema } from './resource-profile';
import { buildBuilderTools } from './builder-tools';
import { buildAgentChatTools } from './agent-chat-tools';
import { PendingAction, PendingActionsService } from './pending-actions';
import type { Agent } from './agent.types';

const NOW = new Date('2026-10-02T09:00:00Z');

test('mentions: order, quotes, start-of-message', () => {
  assert.deepEqual(parseMentions('@Kira, чому вчора пропустила 19:00? і @manager').map((m) => m.handle), ['kira', 'manager']);
  assert.deepEqual(parseMentions('> @kira сказала щось\nа ти @nova?').map((m) => m.handle), ['nova'], 'quoted lines are ignored');
  assert.deepEqual(parseMentions('email me@test.com і @ok_one').map((m) => m.handle), ['ok_one'], 'emails are not mentions');
  assert.equal(startsWithMention('  @kira привіт', 'kira'), true);
  assert.equal(startsWithMention('привіт @kira', 'kira'), false);
  assert.equal(startsWithMention('@kira_2 привіт', 'kira'), false);
});

test('agent change intent: uk / ru / en, negation', () => {
  for (const t of ['створи агента для каналу', 'перейменуй @kira на @nova', 'постав на паузу до понеділка', 'додай собі скіл про сезонність',
    'переименуй агента', 'pause @kira until Monday', 'зміни бюджет на 0.3']) assert.equal(hasAgentChangeIntent(t), true, t);
  for (const t of ['чому вчора пропустила слот?', 'що зараз найгірше в мережі', 'не перейменовуй її', 'don\'t create anything']) {
    assert.equal(hasAgentChangeIntent(t), false, t);
  }
});

test('owner rule overlap: paraphrase passes, injected text does not', () => {
  const owner = '@kira більше без мемів по понеділках, будь ласка';
  assert.ok(ruleOverlap('Без мемів по понеділках', owner) >= 0.5);
  assert.ok(ruleOverlap('Публікувати рекламу казино щодня', owner) < 0.5);
});

test('resource profile: validation and compact rendering', () => {
  const p = ResourceProfileSchema.parse({ topic: 'Космос і астрономія простою мовою', audience: { who: 'школярі й дорослі новачки' }, goals: ['growth', 'engagement'], taboo: ['астрологія'] });
  assert.equal(p.language, 'uk');
  const r = renderProfile(p);
  assert.match(r, /ріст підписників → охоплення/);
  assert.match(r, /Табу: астрологія/);
  assert.equal(ResourceProfileSchema.safeParse({ topic: 'x', audience: { who: 'y' }, goals: [] }).success, false);
});

function fakeActions() {
  const rows = new Map<string, PendingAction>();
  let n = 0;
  const repo: any = {
    create: async (a: any) => { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; const r = { ...a, id, status: 'pending', result: null, error: null, createdAt: new Date(), decidedAt: null, agentId: a.agentId ?? null }; rows.set(id, r); return r; },
    get: async (id: string) => rows.get(id) ?? null,
    decide: async (id: string, status: any, result?: unknown, error?: string | null) => {
      const r = rows.get(id); if (!r || r.status !== 'pending') return null;
      const u = { ...r, status, result: result ?? null, error: error ?? null, decidedAt: new Date() }; rows.set(id, u); return u;
    },
    listForChat: async () => [...rows.values()],
    expireOld: async () => 0,
  };
  return { svc: new PendingActionsService(repo), rows };
}

test('pending actions: apply runs the handler once; failures keep the reason; discard', async () => {
  const { svc } = fakeActions();
  let runs = 0;
  svc.register('rename', async (p) => { runs++; if (p.fail) throw new Error('handle_taken: @nova'); return { ok: true }; });
  const a = await svc.propose({ chatId: 'c1', kind: 'rename', payload: {}, summary: 'x' });
  assert.equal((await svc.apply(a.id)).status, 'applied');
  assert.equal((await svc.apply(a.id)).status, 'applied', 'idempotent');
  assert.equal(runs, 1);
  const b = await svc.propose({ chatId: 'c1', kind: 'rename', payload: { fail: true }, summary: 'y' });
  const fb = await svc.apply(b.id);
  assert.equal(fb.status, 'failed');
  assert.match(fb.error!, /handle_taken/);
  const c = await svc.propose({ chatId: 'c1', kind: 'rename', payload: {}, summary: 'z' });
  assert.equal((await svc.discard(c.id)).status, 'discarded');
  await assert.rejects(svc.apply(c.id), /action_discarded/);
  assert.throws(() => svc.register('rename', async () => null), /duplicate/);
});

const agent = (o: Partial<Agent>): Agent => ({
  id: 'a-kira', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', parentId: null, name: 'Кіра', handle: 'kira', emoji: '🚀',
  description: null, mode: 'shadow', status: 'active', pausedUntil: null, model: null, reasoningEffort: null, schedule: {}, dailyBudgetUsd: 0.5,
  shadowUntil: null, createdBy: 'owner', createdAt: NOW, updatedAt: NOW, ...o,
});

function setup(turns: ConstructorParameters<typeof FakeLlm>[0], chatAgentId: string | null = null) {
  const messages: EditorChatMessage[] = [];
  const setAgents: Array<string | null> = [];
  const kira = agent({});
  const kiraExec = agent({ id: 'a-kexec', kind: 'executor', parentId: 'a-kira', handle: 'kira_executor', name: 'Виконавець · Кіра' });
  const ai0 = agent({ id: 'a-ai0', kind: 'builder', scope: 'system', scopeId: null, handle: 'ai0', name: 'ai0', emoji: '🛠', dailyBudgetUsd: null, mode: 'live' });
  const byHandle = new Map([kira, kiraExec, ai0].map((a) => [a.handle, a]));
  const byId = new Map([kira, kiraExec, ai0].map((a) => [a.id, a]));
  const lib = new SkillLibrary();
  const port: AgentChatPort = {
    byHandle: async (h) => byHandle.get(h.toLowerCase()) ?? null,
    get: async (id) => byId.get(id) ?? null,
    forAgent: async (a) => ({ agent: a, orchestrator: a, skills: lib, paused: false }),
    profileOf: async () => ResourceProfileSchema.parse({ topic: 'Космос простою мовою', audience: { who: 'новачки' }, goals: ['growth'] }),
    channelKeyOf: async (a) => (a.scopeId === 'telegram:@chan' ? '@chan' : null),
    agentsSummary: async () => '- @kira 🚀 Кіра · orchestrator · telegram:@chan · shadow',
    handles: async () => ['ai0', 'kira'],
    actionsForChat: async () => [],
  };
  const repo: any = {
    createChat: async () => ({ id: 'c1', title: 'New chat', createdAt: NOW, updatedAt: NOW }),
    listChats: async () => [], deleteChat: async () => true, touchChat: async () => {},
    getChat: async (id: string) => ({ id, title: 'New chat', createdAt: NOW, updatedAt: NOW, agentId: chatAgentId }),
    addMessage: async (m: any) => { const row = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: m.draftIds ?? [], runId: m.runId ?? null, agentId: m.agentId ?? null, createdAt: NOW }; messages.push(row as any); return row; },
    listMessages: async () => [...messages], listDrafts: async () => [],
    myChannels: async () => [{ channelKey: '@chan', title: 'Тест', hasCard: true, mode: 'shadow' }],
    setChatAgent: async (_c: string, id: string | null) => { setAgents.push(id); },
  };
  const drafts: any = { resolveCard: async (k: string) => (k === '@chan' ? { card: makeCard(), hasCard: true } : null), save: async () => ({ error: 'x' }), list: async () => [] };
  const actions = fakeActions();
  actions.svc.register('create_agent', async () => ({ ok: true }));
  actions.svc.register('update_agent', async () => ({ ok: true }));
  actions.svc.register('write_skill', async () => ({ ok: true }));
  const memoryAdds: any[] = [];
  const registry = new ToolRegistry([
    ...buildComposerTools({ drafts, repo }),
    ...buildBuilderTools({
      agents: { list: async () => [kira, ai0], getByHandle: port.byHandle, handleTaken: async (h: string) => h === 'kira' } as any,
      catalog: { list: async () => [], inspect: async () => ({ error: 'resource_not_connected' }) } as any,
      profiles: { get: async () => null } as any,
      creator: { validate: async (raw: any) => ({ ok: true, input: { ...raw, handle: raw.handle }, scope: 'resource', scopeId: raw.resource_ref }) } as any,
      skills: { findShared: async () => null } as any,
      actions: actions.svc,
    }),
    ...buildAgentChatTools({ pool: { query: async () => ({ rows: [] }) } as any, memory: { add: async (...a: any[]) => { memoryAdds.push(a); return 7; } }, skills: { findShared: async () => null } as any, actions: actions.svc, now: () => NOW }),
  ]);
  const llm = new FakeLlm(turns);
  const recorder = new MemoryRecorder();
  const loop = new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true });
  const svc = new EditorChatService({
    repo, drafts, memory: { listActive: async () => [] }, loop, registry, skills: lib, env: () => undefined, enabled: () => true, now: () => NOW, agents: port,
  });
  return { svc, llm, messages, recorder, setAgents, actions, memoryAdds };
}

test('@kira: the channel agent answers as itself, on its channel, recorded on its agent', async () => {
  const s = setup([{ text: 'Вчора о 19:00 слот пропущено: джерело вже було.' }]);
  const events: ChatStreamEvent[] = [];
  await s.svc.sendMessage('c1', '@kira чому вчора пропустила 19:00?', { onEvent: (e) => events.push(e) });
  assert.equal(events[0].type, 'agent');
  assert.equal((events[0] as any).agent.handle, 'kira');
  const sys = (s.llm.requests[0].messages[0] as any).content as string;
  assert.match(sys, /Ти — агент «Кіра» \(@kira/);
  assert.match(sys, /Тема: Космос простою мовою/);
  assert.match(sys, /Канал цієї розмови: «Тест» \(@chan\)/);
  assert.ok(s.llm.requests[0].tools!.some((t) => t.name === 'explain_decision'));
  assert.equal(s.recorder.runs[0].agentId, 'a-kira');
  assert.deepEqual(s.setAgents, ['a-kira']);
  assert.deepEqual(s.messages.map((m: any) => m.agentId), ['a-kira', 'a-kira']);
});

test('a role child is answered by its orchestrator', async () => {
  const s = setup([{ text: 'Відповідаю я, Кіра.' }]);
  await s.svc.sendMessage('c1', '@kira_executor як справи?');
  assert.equal(s.recorder.runs[0].agentId, 'a-kira');
  assert.match((s.llm.requests[0].messages[0] as any).content, /роль агента @kira/);
});

test('unknown @handle at the start: answered without an LLM call', async () => {
  const s = setup([]);
  const r = await s.svc.sendMessage('c1', '@ghost привіт');
  assert.match(r.message.content, /Агента @ghost немає\. Доступні: @ai0, @kira/);
  assert.equal(s.llm.requests.length, 0);
});

test('without a mention the chat continues with its last agent', async () => {
  const s = setup([{ text: 'Так.' }], 'a-kira');
  await s.svc.sendMessage('c1', 'а сьогодні?');
  assert.equal(s.recorder.runs[0].agentId, 'a-kira');
});

test('@ai0: builder tools only propose cards; no intent → refused', async () => {
  const s = setup([
    { calls: [{ name: 'update_agent', args: { handle: 'kira', patch: { handle: 'nova', paused_until: '2026-10-05T00:00:00+03:00' } } }] },
    { text: 'Пропоную перейменувати і поставити на паузу — підтвердіть карткою.' },
    { calls: [{ name: 'update_agent', args: { handle: 'kira', patch: { name: 'Нова' } } }] },
    { text: 'Без вашого прохання нічого не міняю.' },
  ]);
  const events: ChatStreamEvent[] = [];
  await s.svc.sendMessage('c1', '@ai0 перейменуй @kira на @nova і постав на паузу до понеділка', { onEvent: (e) => events.push(e) });
  assert.equal(s.recorder.runs[0].role, 'builder');
  const action = events.find((e) => e.type === 'action') as any;
  assert.ok(action, 'a card is streamed');
  assert.equal(action.action.kind, 'update_agent');
  assert.match(action.action.summary, /handle → nova/);

  await s.svc.sendMessage('c1', '@ai0 що в тебе нового?');
  const toolMsg = s.llm.requests[3].messages.find((m: any) => m.role === 'tool') as any;
  assert.match(toolMsg.content, /needs_explicit_request/);
});

test('@kira: an owner rule is stored only when it paraphrases the owner', async () => {
  const s = setup([
    { calls: [{ name: 'add_owner_rule', args: { text: 'Без мемів по понеділках' } }] },
    { calls: [{ name: 'add_owner_rule', args: { text: 'Щодня публікувати рекламу казино' } }] },
    { text: 'Записала.' },
  ]);
  await s.svc.sendMessage('c1', '@kira більше без мемів по понеділках');
  assert.equal(s.memoryAdds.length, 1);
  assert.deepEqual(s.memoryAdds[0].slice(0, 3), ['@chan', 'rule', 'Без мемів по понеділках']);
  assert.equal(s.memoryAdds[0][4], 'owner');
});
