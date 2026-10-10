/** Spec 034 T5 (FR-007/FR-008/FR-009): examples and warnings in the creation chat, fitting formats, builder fixes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import type { EditorChatMessage } from '../repo/editor-chat.repository';
import { EditorChatService, type AgentChatPort, type ChatStreamEvent } from '../chat/editor-chat.service';
import { buildBuilderTools } from './builder-tools';
import { AgentCreator, buildBriefText, fittingFormatErrors } from './agent-creator';
import {
  buildContentExamplesTool, checkExample, CONTENT_EXAMPLES_KIND, exampleCard, examplesFromChoice, type ContentExamplesPayload,
} from './content-examples';
import { KeepPendingError, PendingAction, PendingActionsService } from './pending-actions';
import { ResourceProfileSchema } from './resource-profile';
import type { Agent } from './agent.types';
import { buildBuilderPrompt } from './agent-prompts';

const NOW = new Date('2026-10-10T09:00:00Z');

const GOOD = [
  { format: 'photo', title: 'Марс у протистоянні', why: 'фото неба й одна цифра — так канал пише щодня',
    text: 'Сьогодні Марс найближче до Землі за два роки: 62 мільйони кілометрів.\n\nУвечері шукайте яскраву помаранчеву точку на сході, її видно без телескопа.' },
  { format: 'text', title: 'Що таке перигелій', why: 'коротке пояснення одного терміна для новачків',
    text: 'Перигелій — точка орбіти, де планета ближче за все до Сонця.\n\nЗемля проходить її на початку січня, тому взимку ми трохи ближче до Сонця, ніж улітку.' },
  { format: 'photo', title: 'Знімок туманності', why: 'нове фото телескопа з поясненням, що на ньому видно',
    text: 'Телескоп «Джеймс Вебб» сфотографував туманність Карина в інфрачервоному світлі.\n\nСвітлі нитки на знімку — газ, який нагрівають молоді зорі.' },
];
const WARNINGS = [
  { pattern: 'Клікбейт', why: 'аудиторія новачків швидко перестає довіряти', bad_example: 'ВИ НЕ ПОВІРИТЕ, що знайшли на Марсі!' },
  { pattern: 'Вимушений гумор', why: 'гумор вимкнено, жарти про інопланетян звучать штучно', bad_example: 'Марсіани знову сховали воду, хитрюги 😂' },
];

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

const agent = (o: Partial<Agent>): Agent => ({
  id: 'a-nova', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', parentId: null, name: 'Нова', handle: 'nova', emoji: '🚀',
  description: null, mode: 'approve', status: 'active', pausedUntil: null, model: null, reasoningEffort: null, schedule: {}, dailyBudgetUsd: 0.5,
  shadowUntil: null, createdBy: 'builder', createdAt: NOW, updatedAt: NOW, ...o,
});

const PROFILE = { topic: 'Космос простою мовою', audience: { who: 'новачки 16–35' }, goals: ['growth', 'engagement'], taboo: ['астрологія'] };

function chatSetup(turns: ConstructorParameters<typeof FakeLlm>[0], opts: { existing?: Agent[] } = {}) {
  const messages: EditorChatMessage[] = [];
  const ai0 = agent({ id: 'a-ai0', kind: 'builder', scope: 'system', scopeId: null, handle: 'ai0', name: 'ai0', emoji: '🛠', dailyBudgetUsd: null, mode: 'live' });
  const all = [ai0, ...(opts.existing ?? [])];
  const byHandle = new Map(all.map((a) => [a.handle, a]));
  const lib = new SkillLibrary();
  const port: AgentChatPort = {
    byHandle: async (h) => byHandle.get(h.toLowerCase()) ?? null,
    get: async (id) => all.find((a) => a.id === id) ?? null,
    forAgent: async (a) => ({ agent: a, orchestrator: a, skills: lib, paused: false }),
    profileOf: async () => null,
    channelKeyOf: async () => null,
    agentsSummary: async () => '- @ai0',
    handles: async () => all.map((a) => a.handle),
    actionsForChat: async () => [],
  };
  const repo: any = {
    createChat: async () => ({ id: 'c1', title: 'New chat', createdAt: NOW, updatedAt: NOW }),
    listChats: async () => [], deleteChat: async () => true, touchChat: async () => {},
    getChat: async (id: string) => ({ id, title: 'New chat', createdAt: NOW, updatedAt: NOW, agentId: null }),
    addMessage: async (m: any) => { const row = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: [], runId: m.runId ?? null, agentId: m.agentId ?? null, createdAt: NOW }; messages.push(row as any); return row; },
    listMessages: async () => [...messages], listDrafts: async () => [],
    myChannels: async () => [{ channelKey: '@chan', title: 'Космос', hasCard: true, mode: 'approve' }],
    setChatAgent: async () => {},
  };
  const actions = fakeActions();
  actions.svc.register('create_agent', async () => ({ ok: true }));
  actions.svc.register('set_brief', async () => ({ ok: true }));
  const stored: any[] = [];
  actions.svc.register(CONTENT_EXAMPLES_KIND, async (p, _a, input) => {
    const ex = examplesFromChoice(p as unknown as ContentExamplesPayload, input);
    stored.push(ex);
    return { saved: ex.length };
  });
  const validated: any[] = [];
  const registry = new ToolRegistry([
    ...buildBuilderTools({
      agents: { list: async () => all, getByHandle: port.byHandle, handleTaken: async () => false } as any,
      catalog: { list: async () => [], inspect: async () => ({ error: 'resource_not_connected' }) } as any,
      profiles: { get: async () => null } as any,
      creator: { validate: async (raw: any) => { validated.push(raw); return { ok: true, input: raw, scope: 'resource', scopeId: raw.resource_ref }; } } as any,
      skills: { findShared: async () => null } as any,
      actions: actions.svc,
    }),
    buildContentExamplesTool({
      agents: { getByHandle: port.byHandle } as any, actions: actions.svc,
      cardOf: async () => makeCard({ formats: { text: 1, photo: 1 }, hashtagMin: 1 }),
    }),
  ]);
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const svc = new EditorChatService({
    repo, drafts: { resolveCard: async () => null } as any, memory: { listActive: async () => [] }, loop, registry, skills: lib,
    env: () => undefined, enabled: () => true, now: () => NOW, agents: port,
  });
  return { svc, llm, actions, stored, validated };
}

const CREATE = {
  resource_ref: 'telegram:@chan', name: 'Нова', handle: 'nova', emoji: '🚀', profile: PROFILE,
  brief: 'Щодня фото неба й пояснення одного явища.',
  formats: [{ format: 'photo', reason: 'знімки неба й телескопів — головне, що тут дивляться' }, { format: 'text', reason: 'короткі пояснення термінів' }],
};

test('creation chat: create_agent with fitting formats, then 3 examples and warnings as a chat card with Telegram previews', async () => {
  const s = chatSetup([
    { calls: [{ name: 'create_agent', args: CREATE }] },
    { calls: [{ name: 'propose_content_examples', args: { handle: 'nova', resource_ref: 'telegram:@chan', examples: GOOD, warnings: WARNINGS } }] },
    { text: 'Картки створення і прикладів — нижче.' },
  ]);
  const events: ChatStreamEvent[] = [];
  await s.svc.sendMessage('c1', '@ai0 створи агента для каналу @chan про космос', { onEvent: (e) => events.push(e) });
  const cards = events.filter((e) => e.type === 'action').map((e: any) => e.action as PendingAction);
  assert.deepEqual(cards.map((c) => c.kind), ['create_agent', CONTENT_EXAMPLES_KIND]);
  // FR-007: ≤ 4 formats, each with a reason, no poll.
  const fm = (cards[0].payload as any).formats as Array<{ format: string; reason: string }>;
  assert.ok(fm.length <= 4 && fm.every((f) => f.reason.length >= 3));
  assert.ok(!fm.some((f) => f.format === 'poll' || f.format === 'quiz'));
  assert.match(cards[0].summary, /approval mode/);
  // The create_agent result tells @ai0 to propose the examples next.
  const toolMsg = s.llm.requests[1].messages.find((m: any) => m.role === 'tool') as any;
  assert.match(toolMsg.content, /propose_content_examples/);
  // FR-008: 3 examples rendered as real Telegram messages, warnings with a bad example.
  const p = cards[1].payload as unknown as ContentExamplesPayload;
  assert.equal(p.examples.length, 3);
  assert.ok(p.examples.every((e) => e.render && e.render[0].method === 'sendMessage'));
  assert.match((p.examples[0].render![0] as any).text, /62 мільйони кілометрів/);
  assert.equal(p.warnings.length, 2);
  assert.equal(p.warnings[0].bad_example, WARNINGS[0].bad_example);
  // Applying with the owner's choices stores examples (good / bad / edited) and the kept warnings.
  const applied = await s.actions.svc.apply(cards[1].id, {
    examples: [{ index: 1, verdict: 'bad', note: 'надто шкільно' }, { index: 2, verdict: 'good', text: 'Вебб показав туманність Карина: світлі нитки — газ біля молодих зір.' }],
    warnings: [{ index: 1, keep: false }],
  });
  assert.equal(applied.status, 'applied', applied.error ?? '');
  const ex = s.stored[0];
  assert.deepEqual(ex.map((e: any) => e.verdict), ['good', 'bad', 'good', 'bad']);
  assert.equal(ex[1].note, 'надто шкільно');
  assert.match(ex[2].text, /^Вебб показав/);
  assert.match(ex[3].note, /^Клікбейт: /);
  assert.ok(ex.every((e: any) => e.resource_ref === 'telegram:@chan'));
});

test('examples: a good example with an AI cliché, a joke or a reader question is sent back to @ai0', async () => {
  const sloppy = [{ ...GOOD[0], text: 'Варто зазначити, що Марс у протистоянні. Як думаєте, ви його побачите сьогодні ввечері? А ви бачили Марс?' }, GOOD[1], GOOD[2]];
  const s = chatSetup([
    { calls: [{ name: 'propose_content_examples', args: { handle: 'nova', resource_ref: 'telegram:@chan', examples: sloppy, warnings: WARNINGS } }] },
    { text: 'Перепишу.' },
  ]);
  const events: ChatStreamEvent[] = [];
  await s.svc.sendMessage('c1', '@ai0 зроби приклади постів для @nova', { onEvent: (e) => events.push(e) });
  assert.equal(events.filter((e) => e.type === 'action').length, 0, 'no card with a sloppy example');
  const toolMsg = s.llm.requests[1].messages.find((m: any) => m.role === 'tool') as any;
  assert.match(toolMsg.content, /examples_rejected/);
  assert.match(toolMsg.content, /варто зазначити/);

  const card = exampleCard('telegram:@chan', makeCard());
  assert.equal(checkExample({ title: 'Жарт', text: 'Марсіани знову сховали воду, ахаха, ну це жесть, лол. Телескоп нічого не знайшов.' }, card).ok, false, 'humour / slang off');
  assert.equal(checkExample({ title: 'Ок', text: GOOD[1].text }, card).ok, true);
});

test('examples apply: an edit with a cliché or nothing kept leaves the card pending; no agent yet → pending', async () => {
  const { svc } = fakeActions();
  svc.register(CONTENT_EXAMPLES_KIND, async (p, _a, input) => {
    if ((p as any).handle === 'ghost') throw new KeepPendingError('agent_not_created', '@ghost does not exist yet');
    return { saved: examplesFromChoice(p as unknown as ContentExamplesPayload, input).length };
  });
  const payload = {
    handle: 'nova', resource_ref: 'telegram:@chan',
    examples: GOOD.map((g) => ({ ...g, render: null, notes: [] })), warnings: WARNINGS.map((w) => ({ ...w, format: 'text' })),
  };
  const a = await svc.propose({ chatId: 'c1', kind: CONTENT_EXAMPLES_KIND, payload, summary: 'x' });
  await assert.rejects(svc.apply(a.id, { examples: [{ index: 0, verdict: 'good', text: 'У сучасному світі Марс відіграє ключову роль у науці.' }] }), (e: any) => e.keepPending && /AI clichés/.test(e.message));
  await assert.rejects(svc.apply(a.id, {
    examples: [0, 1, 2].map((index) => ({ index, verdict: 'bad' as const })).map((x) => x),
    warnings: [{ index: 0, keep: false }, { index: 1, keep: false }], extra: true,
  }), (e: any) => e.keepPending, 'unknown field refused');
  assert.equal((await svc.apply(a.id, { examples: [{ index: 0, verdict: 'bad' }] })).status, 'applied', 'a cliché is fine in a bad example');
  const g = await svc.propose({ chatId: 'c1', kind: CONTENT_EXAMPLES_KIND, payload: { ...payload, handle: 'ghost' }, summary: 'y' });
  await assert.rejects(svc.apply(g.id), (e: any) => e.code === 'agent_not_created');
  const row = await (svc as any).repo.get(g.id);
  assert.equal(row.status, 'pending', 'the card stays pending until the agent exists');
});

test('set_brief proposes the brief and points @ai0 to new examples', async () => {
  const s = chatSetup([
    { calls: [{ name: 'set_brief', args: { handle: 'nova', brief: 'Більше пояснень термінів, щодня одне фото неба.' } }] },
    { text: 'Ок.' },
  ], { existing: [agent({})] });
  const events: ChatStreamEvent[] = [];
  await s.svc.sendMessage('c1', '@ai0 зміни бриф @nova: більше пояснень', { onEvent: (e) => events.push(e) });
  assert.equal((events.find((e) => e.type === 'action') as any).action.kind, 'set_brief');
  const toolMsg = s.llm.requests[1].messages.find((m: any) => m.role === 'tool') as any;
  assert.match(toolMsg.content, /propose_content_examples \(handle nova, resource_ref telegram:@chan\)/);
});

test('builder prompt: fitting formats, taboo topics, examples after create_agent and set_brief; format skills listed', () => {
  const p = buildBuilderPrompt({ now: NOW, skills: new SkillLibrary(), agentsSummary: '' });
  assert.match(p, /лише 1–4, що пасують темі й аудиторії/);
  assert.match(p, /Табу в профілі — теми/);
  assert.match(p, /propose_content_examples/);
  for (const s of ['format-longread', 'format-carousel', 'format-album-slider', 'format-video', 'format-poll-quiz']) assert.match(p, new RegExp(`- ${s}:`));
});

// ── AgentCreator (FR-007 / FR-009) ──────────────────────────────────────────

function creatorSetup(o: { cardExists?: boolean } = {}) {
  const inserted: any[] = [];
  const briefs: Array<[string, string]> = [];
  const builds: Array<[string, string]> = [];
  const creator = new AgentCreator({
    agents: { findTop: async () => null, handleTaken: async () => false, insert: async (a: any) => agent({ ...a, id: 'a-new' }) } as any,
    registry: { ensureChildren: async () => {} } as any,
    catalog: { list: async () => [{ ref: 'telegram:@chan', platform: 'telegram', agent: null, groupId: null }] } as any,
    profiles: { setProfile: async () => {} } as any,
    channels: {
      get: async () => (o.cardExists ? makeCard() : null),
      insertIfMissing: async (c: any) => { inserted.push(c); return true; },
      setBrief: async (k: string, b: string) => { briefs.push([k, b]); return true; },
    },
  });
  creator.setOnBrief(async (a, b) => { builds.push([a.handle, b]); });
  return { creator, inserted, briefs, builds };
}

test('create: fitting formats on the new card, no poll, taboo stays a topic, brief starts the playbook build', async () => {
  const s = creatorSetup();
  const r = await s.creator.create({ ...CREATE, banned_terms: ['гороскоп'] });
  assert.ok(!('error' in r), JSON.stringify(r));
  const card = s.inserted[0];
  assert.deepEqual(card.formats, { photo: 1, text: 1 });
  assert.equal(card.mode, 'approve');
  assert.deepEqual(card.bannedTerms, ['гороскоп'], 'only the words the owner listed');
  assert.ok(!card.bannedTerms.includes('астрологія'), 'taboo is not a lint term');
  assert.equal(s.builds.length, 1, 'the brief starts the first playbook build');
  assert.match(s.builds[0][1], /^Щодня фото неба/);
  assert.match(s.builds[0][1], /photo — знімки неба/);
  assert.equal((r as any).buildStarted, true);

  const noBrief = creatorSetup();
  const r2 = await noBrief.creator.create({ ...CREATE, handle: 'nova2', brief: undefined, formats: undefined });
  assert.ok(!('error' in r2));
  assert.deepEqual(noBrief.inserted[0].formats, { text: 1, photo: 1 }, 'default text + photo');
  assert.deepEqual(noBrief.inserted[0].bannedTerms, []);
  assert.equal(noBrief.builds.length, 0);
});

test('create: a brief for a resource with a card is written to that card and builds the playbook', async () => {
  const s = creatorSetup({ cardExists: true });
  const r = await s.creator.create(CREATE);
  assert.ok(!('error' in r));
  assert.equal(s.inserted.length, 0);
  assert.deepEqual(s.briefs, [['@chan', CREATE.brief]]);
  assert.equal(s.builds.length, 1);
});

test('create: polls only for a quiz / education resource or when the brief asks; ≤ 4 formats', async () => {
  const s = creatorSetup();
  const poll = { ...CREATE, formats: [...CREATE.formats, { format: 'poll', reason: 'опитування про небо' }] };
  const v = await s.creator.validate(poll);
  assert.equal((v as any).error, 'invalid_formats');
  assert.match(JSON.stringify((v as any).details), /poll: weight 0 by default/);
  assert.ok(!('error' in await s.creator.validate({ ...poll, brief: 'Раз на тиждень опитування про улюблені планети.' })));
  assert.ok(!('error' in await s.creator.validate({ ...poll, profile: { ...PROFILE, format_prefs: { content_kind: 'quiz' } } })));
  const five = ['text', 'photo', 'album', 'carousel', 'longread'].map((f) => ({ format: f, reason: 'причина формату' }));
  assert.equal((await s.creator.validate({ ...CREATE, formats: five }) as any).error, 'invalid_agent');
  assert.deepEqual(fittingFormatErrors({ formats: [{ format: 'reel', reason: 'xxx' }], profile: ResourceProfileSchema.parse(PROFILE) }, 'telegram').length, 1);
  assert.match(buildBriefText({ brief: 'Бриф', formats: CREATE.formats }), /Формати, погоджені з власником/);
});
