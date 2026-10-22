/**
 * Spec 062 T3: add_owner_rule reports only the conflicts it causes, edit_my_skill warns about a language the channel's lint
 * rejects and about dated facts, and /align runs fix_config_conflicts in code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import type { EditorChatMessage } from '../repo/editor-chat.repository';
import { buildAgentChatTools, newConflicts } from '../agents/agent-chat-tools';
import { dateWarning, languageWarning, skillWarnings } from '../agents/skill-warnings';
import { EditorChatService } from './editor-chat.service';
import { parseSlash, runSlash, SLASH_COMMANDS, type SlashDeps } from './slash-commands';
import { alignAgent } from './align';

const NOW = new Date('2026-10-22T09:00:00Z');

// ── FR-007: add_owner_rule ──────────────────────────────────────────────────

const HASHTAG_OLD = { code: 'hashtags_off', ref: 'telegram:@chan', detail: 'playbook asks for hashtags, a rule says none', rule_id: 3 };
const SLANG_NEW = { code: 'slang_on', ref: 'telegram:@chan', detail: 'profile allows slang, the new rule forbids it', rule_id: 41 };

function ruleSetup(conflictsAt: Array<any[]>) {
  const adds: any[] = [];
  let n = 0;
  const tool = buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any,
    memory: { add: async (...a: any[]) => { adds.push(a); return 41; } },
    skills: { findShared: async () => null },
    actions: { propose: async (a: any) => ({ id: 'pa1', ...a, status: 'pending' }) as any },
    conflicts: { forAgent: async () => conflictsAt[Math.min(n++, conflictsAt.length - 1)] } as any,
  }).find((t) => t.name === 'add_owner_rule')!;
  const ctx: any = {
    runId: 'r', role: 'composer', channelKey: '@chan',
    extras: { chat: { chatId: 'c1', channelKey: '@chan' }, agentIntent: false, ownerText: 'Пости мають бути без сленгу', ownerRecent: ['Пости мають бути без сленгу'], agent: { id: 'a-kira', handle: 'kira' } },
  };
  return { tool, ctx, adds, reads: () => n };
}

test('newConflicts: the ones that were not there before, and the ones that name the rule', () => {
  const before = [HASHTAG_OLD];
  assert.deepEqual(newConflicts(before, [HASHTAG_OLD, SLANG_NEW], 41), [SLANG_NEW]);
  assert.deepEqual(newConflicts(before, [HASHTAG_OLD], 41), []);
  // The same code and ref as before, but caused by this rule too (it names it): reported.
  assert.deepEqual(newConflicts(before, [{ ...HASHTAG_OLD, rule_id: 41 }], 41).map((c) => c.rule_id), [41]);
});

test('add_owner_rule returns only the conflicts the new rule causes; an old hashtag conflict stays out', async () => {
  const s = ruleSetup([[HASHTAG_OLD], [HASHTAG_OLD, SLANG_NEW]]);
  const r: any = await s.tool.execute({ text: 'Пости без сленгу', kind: 'rule' }, s.ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config_conflicts, [SLANG_NEW.detail]);
  assert.match(r.note, /\/align @channel/);
  assert.equal(s.reads(), 2, 'read before and after the rule is stored');

  const quiet = ruleSetup([[HASHTAG_OLD], [HASHTAG_OLD]]);
  const q: any = await quiet.tool.execute({ text: 'Пости без сленгу', kind: 'rule' }, quiet.ctx);
  assert.equal(q.ok, true);
  assert.equal('config_conflicts' in q, false, 'a rule that causes no conflict reports none, though the channel has an old one');
});

// ── FR-007: edit_my_skill ───────────────────────────────────────────────────

test('skill warnings: a language the lint rejects, dated facts; verbatim text and a mixed channel are fine', () => {
  const uk = { language: 'uk' };
  assert.match(languageWarning('Always write captions in English only.', uk)!, /not_ukrainian/);
  assert.match(languageWarning('Пиши підписи лише англійською мовою.', uk)!, /англійська \(en\)/);
  assert.equal(languageWarning('Пиши підписи українською.', uk), null);
  assert.equal(languageWarning('Prompt text stays in English inside the code block.', uk), null, 'verbatim text is not prose');
  assert.equal(languageWarning('Always write captions in English only.', { language: 'mixed' }), null, 'mixed: the lint does not reject by language');
  assert.equal(languageWarning('Always write captions in English only.', { language: 'pl' }), null, 'same script: the lint does not reject');
  assert.match(languageWarning('Пиши підписи лише українською.', { language: 'en' })!, /wrong_language/);
  assert.equal(languageWarning('Always write captions in English only.', null), null, 'no card, nothing to compare');

  assert.match(dateWarning('Каталог станом на 2026-10-18 порожній.')!, /станом на 2026-10-18/);
  assert.match(dateWarning('Станом на сьогодні промптів немає.')!, /станом на сьогодні/i);
  assert.match(dateWarning('As of today the dataset is empty.')!, /as of today/i);
  assert.equal(dateWarning('Каталог оновлюється щодня.'), null);
  assert.equal(skillWarnings('Пиши підписи українською. Кроки: 1, 2.', { language: 'uk' }).length, 0);
  assert.equal(skillWarnings('Write captions in English only. Станом на 2026-10-18 це так.', { language: 'uk' }).length, 2);
});

test('edit_my_skill still proposes the card and returns the warnings for the model to tell the owner', async () => {
  const proposed: any[] = [];
  const tool = buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any,
    memory: { add: async () => 1 }, skills: { findShared: async () => null },
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa2', ...a, status: 'pending' } as any; } },
  }).find((t) => t.name === 'edit_my_skill')!;
  const ctx = (body: string) => ({
    runId: 'r', role: 'composer', channelKey: '@chan',
    extras: { chat: { chatId: 'c1', channelKey: '@chan' }, agent: { id: 'a-kira', handle: 'kira', kind: 'orchestrator' }, card: { language: 'uk' } },
  }) as any;
  const base = { name: 'prompts-guide', description: 'How to write prompt posts for the channel', body: '' };
  const bad: any = await tool.execute({ ...base, body: 'Always write captions in English only.\nСтаном на 2026-10-18 каталог порожній.\nКрок 1: візьми рядок.' }, ctx(''));
  assert.equal(bad.ok, true);
  assert.equal(bad.pending_action, 'pa2', 'a warning is not a block');
  assert.equal(proposed.length, 1);
  assert.equal(bad.warnings.length, 2, 'the English-only line and the dated fact');
  const dated: any = await tool.execute({ ...base, body: 'Пиши підписи українською.\nКаталог станом на 2026-10-18 порожній.' }, ctx(''));
  assert.match(dated.warnings[0], /станом на 2026-10-18/);
  assert.match(dated.warnings_note, /скажи власнику/);
  const clean: any = await tool.execute({ ...base, body: 'Пиши підписи українською, коротко.\nКрок 1: візьми рядок.' }, ctx(''));
  assert.equal(clean.ok, true);
  assert.equal('warnings' in clean, false);
});

// ── FR-008: /align ──────────────────────────────────────────────────────────

const ACTION = { id: 'act-1', kind: 'fix_config_conflicts', status: 'pending', summary: 'Align @news', payload: {}, createdAt: NOW } as any;

function alignDeps(items: string[], seen: unknown[][] = []): SlashDeps {
  const noop = async () => ({ ok: false as const, error: 'x' });
  return {
    setup: noop, steer: noop, launch: noop, list: async () => [],
    align: async (target, chatId) => {
      seen.push([target, chatId]);
      if (target === '@ghost') return { ok: false, error: 'unknown_agent' };
      return { ok: true, handle: 'news', action: items.length ? ACTION : null, items };
    },
  };
}

test('/align: the card plus a short item list; nothing to align; unknown target; usage', async () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.name === 'align' && c.args === '@channel'));
  const seen: unknown[][] = [];
  const ctx = { agent: 'news', channel: '@news', chatId: 'c1' };
  const many = Array.from({ length: 10 }, (_, i) => `item ${i}`);
  const r = await runSlash(parseSlash('/align @news_ch')!, ctx, alignDeps(many, seen));
  assert.deepEqual(seen[0], ['@news_ch', 'c1']);
  assert.equal(r.action, ACTION);
  assert.match(r.content, /^@news has 10 items to align with your rules\./);
  assert.match(r.content, /\n- item 0\n/);
  assert.match(r.content, /\n- … and 2 more$/);
  assert.equal(r.content.split('\n- ').length - 1, 9, 'eight items and the «and 2 more» line');

  const own = await runSlash(parseSlash('/align')!, ctx, alignDeps(['one'], seen));
  assert.deepEqual(seen[1], ['@news', 'c1'], 'in a chat with an agent the agent is the default target');
  assert.match(own.content, /^@news has 1 item to align/);

  const none = await runSlash(parseSlash('/align @news_ch')!, ctx, alignDeps([]));
  assert.equal(none.action, undefined);
  assert.match(none.content, /already agree — nothing to align/);
  assert.match((await runSlash(parseSlash('/align @ghost')!, ctx, alignDeps(['x'])) ).content, /@ghost is not a channel or agent of the network/);
  assert.equal((await runSlash(parseSlash('/align a b')!, ctx, alignDeps(['x']))).content, 'Usage: /align @channel');
  assert.equal((await runSlash(parseSlash('/align')!, { agent: null, channel: null }, alignDeps(['x']))).content, 'Name the channel: /align @channel');
});

test('alignAgent: finds the agent by handle or channel, proposes the same card the tool does, nothing when aligned', async () => {
  const kira: any = { id: 'a-kira', handle: 'kira', kind: 'orchestrator', parentId: null };
  const role: any = { id: 'a-role', handle: 'kira_writer', kind: 'role', parentId: 'a-kira' };
  const proposed: any[] = [];
  let items: any[] = [{ key: 'conflict:slang_on:x', kind: 'conflict', detail: 'slang on' }, { key: 'rule:7', kind: 'junk_rule', detail: 'Retire rule #7' }];
  const d = {
    agents: { getByHandle: async (h: string) => (h === 'kira' ? kira : h === 'kira_writer' ? role : null), get: async (id: string) => (id === 'a-kira' ? kira : null), list: async () => [kira, role] },
    channelKeyOf: async (a: any) => (a.id === 'a-kira' ? '@kira_news' : null),
    conflicts: { resolverFor: async () => items },
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'act-9', ...a, status: 'pending' }; } },
  } as any;
  const byHandle = await alignAgent(d, '@kira', 'c1');
  assert.ok(byHandle.ok && byHandle.action && byHandle.handle === 'kira');
  assert.deepEqual(byHandle.ok && byHandle.items, ['slang on', 'Retire rule #7']);
  assert.equal(proposed[0].kind, 'fix_config_conflicts');
  assert.equal(proposed[0].chatId, 'c1');
  assert.equal(proposed[0].agentId, 'a-kira');
  assert.deepEqual(proposed[0].payload, { handle: 'kira', items });
  assert.equal(proposed[0].summary, "Align @kira with the owner's rules: 2 items (conflict, junk rule)");
  const byChannel = await alignAgent(d, '@kira_news', 'c1');
  assert.ok(byChannel.ok && byChannel.handle === 'kira');
  const byRole = await alignAgent(d, '@kira_writer', 'c1');
  assert.ok(byRole.ok && byRole.handle === 'kira', 'a role resolves to its orchestrator');
  assert.deepEqual(await alignAgent(d, '@ghost', 'c1'), { ok: false, error: 'unknown_agent' });
  items = [];
  const done = await alignAgent(d, '@kira', 'c1');
  assert.ok(done.ok && done.action === null && done.items.length === 0);
  assert.equal(proposed.length, 3, 'nothing proposed when aligned');
});

test('the chat service runs /align without a model turn and streams the card', async () => {
  const messages: EditorChatMessage[] = [];
  const repo: any = {
    createChat: async () => ({ id: 'c1' }), listChats: async () => [], deleteChat: async () => true, touchChat: async () => {},
    getChat: async () => ({ id: 'c1', title: 't', createdAt: NOW, updatedAt: NOW, agentId: 'a-news' }),
    addMessage: async (m: any) => {
      const r = { id: messages.length + 1, chatId: m.chatId, role: m.role, content: m.content, draftIds: [], runId: null, artifacts: m.artifacts ?? null, createdAt: NOW };
      messages.push(r);
      return r;
    },
    listMessages: async () => [...messages], listDrafts: async () => [], myChannels: async () => [],
  };
  const llm = new FakeLlm([]);
  const seen: unknown[][] = [];
  const news: any = { id: 'a-news', handle: 'news', kind: 'orchestrator', parentId: null };
  const svc = new EditorChatService({
    repo, drafts: {} as any, memory: { listActive: async () => [] }, skills: new SkillLibrary(), registry: new ToolRegistry([]),
    loop: new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true }),
    env: () => undefined, enabled: () => true, now: () => NOW, slash: alignDeps(['slang on', 'hashtags off'], seen),
    agents: { get: async () => news, channelKeyOf: async () => '@news', handles: async () => ['news'] } as any,
  });
  const events: any[] = [];
  const r = await svc.sendMessage('c1', '/align @news', { onEvent: (e) => events.push(e) });
  assert.equal(llm.requests.length, 0, 'no model run');
  assert.deepEqual(seen[0], ['@news', 'c1']);
  assert.match(r.message.content, /^@news has 2 items to align with your rules\.[\s\S]*- slang on\n- hashtags off$/);
  assert.deepEqual(events.map((e) => e.type), ['action', 'message']);
  assert.equal(events[0].action.id, 'act-1');
});
