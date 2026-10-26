import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceInSkill, sourceRefusal } from './skill-warnings';
import { buildAgentChatTools } from './agent-chat-tools';
import { buildBuilderTools } from './builder-tools';
import type { ToolContext } from '../harness/tool';

/** Spec 069 FR-002: where the posts come from is an import card, never a skill. */

test('sourceInSkill refuses a skill that tells the agent to take posts from a URL or an API', () => {
  const r = sourceInSkill('# Джерело\nБери пости з https://prompthero.com/api/feed через їхній API і публікуй щодня.');
  assert.equal(r?.kind, 'url');
  assert.match(r!.sentence, /prompthero\.com/);
  assert.equal(sourceInSkill('Take the prompts from the vendor API every morning.')?.kind, 'url');
  assert.equal(sourceInSkill('Fetch new posts from https://example.com/feed.json')?.kind, 'url');
});

test('sourceInSkill refuses a provider filter', () => {
  assert.equal(sourceInSkill('Фільтр provider=prompthero: бери лише рядки цього провайдера.')?.kind, 'provider');
  assert.equal(sourceInSkill('query_data({ filter: { provider = "nanobanana" } })')?.kind, 'provider');
});

test('sourceInSkill refuses a dataset named as the place to take posts from instead of the series source', () => {
  const r = sourceInSkill('Пости бери тільки з library:nanobanana_prompts замість джерела серії.');
  assert.equal(r?.kind, 'dataset');
  assert.equal(sourceInSkill('Use only dataset nanobanana_prompts instead of the series source.')?.kind, 'dataset');
});

test('sourceInSkill lets a style-only skill and a skill about HOW to use a dataset pass', () => {
  assert.equal(sourceInSkill('# Стиль\nПиши коротко, без емодзі. Перший рядок — гачок. Підпис — лише назва автора.'), null);
  assert.equal(sourceInSkill([
    '# Як користуватись рядком датасету',
    'Вибери рядок, який ще не публікувався. Залиш промпт дослівно, не переписуй його.',
    'Вкажи автора й посилання на оригінал з полів рядка (author, source_url).',
    'Перекладай лише підпис, не сам промпт.',
  ].join('\n')), null);
  assert.equal(sourceInSkill('Credit the author with the link from the row. Keep the prompt verbatim.'), null);
  assert.equal(sourceInSkill('Додай посилання https://t.me/ai0_global в кінці допису.'), null, 'a link to put in a post is not a source to take posts from');
});

test('sourceRefusal is the tool error: a code, what was found and where the change belongs', () => {
  const e = sourceRefusal('Бери пости з https://prompthero.com API щодня.')!;
  assert.equal(e.error, 'source_belongs_in_import');
  assert.match(e.details, /prompthero\.com/);
  assert.match(e.hint, /import_list/);
  assert.equal(sourceRefusal('Пиши коротко.'), null);
});

const BODY_SOURCE = '# Джерело\nБери промпти з https://prompthero.com/api API та публікуй їх щодня без змін.';
const BODY_STYLE = '# Стиль промптів\nЗалишай промпт дослівно, вказуй автора й посилання на оригінал з полів рядка датасету.';

test('edit_my_skill refuses a source skill with source_belongs_in_import and proposes a style skill', async () => {
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any, memory: { add: async () => 1 } as any,
    skills: { findShared: async () => null } as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'composer', channelKey: null, extras: { chat: { chatId: 'c', channelKey: '@x' }, agent: { id: 'a-1', handle: 'ai_global', kind: 'orchestrator' }, ownerText: 'x' } } as unknown as ToolContext;
  const input = (body: string) => ({ name: 'prompts-source', description: 'How the channel takes its prompts', body });

  const refused = await tools.edit_my_skill.execute(input(BODY_SOURCE), ctx);
  assert.equal(refused.error, 'source_belongs_in_import');
  assert.equal(proposed.length, 0);
  const ok = await tools.edit_my_skill.execute(input(BODY_STYLE), ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(proposed.length, 1);
});

test('the builder\'s write_skill refuses it too', async () => {
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildBuilderTools({
    agents: { getByHandle: async () => ({ id: 'a-1', handle: 'ai_global', kind: 'orchestrator' }), list: async () => [], handleTaken: async () => false } as any,
    catalog: {} as any, profiles: {} as any, creator: {} as any,
    skills: { findShared: async () => null, findForAgent: async () => null } as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'builder', channelKey: null, extras: { chat: { chatId: 'c', channelKey: null }, ownerText: 'x' } } as unknown as ToolContext;
  const input = (body: string) => ({ handle: 'ai_global', name: 'prompts-source', description: 'How the channel takes its prompts', applies_to: ['composer'], body });
  assert.equal((await tools.write_skill.execute(input(BODY_SOURCE), ctx)).error, 'source_belongs_in_import');
  assert.equal(proposed.length, 0);
  assert.equal((await tools.write_skill.execute(input(BODY_STYLE), ctx)).ok, true);
});
