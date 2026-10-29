/**
 * Spec 073 FR-012: the chat's `edit_my_skill` and the builder's `write_skill` also refuse a skill that contradicts a series of the
 * channel, when the store gives them its `writeProblems`; without it they behave as before (069). The old Prompt skill passes the
 * two older checks, so this is the check that stops it on the chat paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentChatTools } from './agent-chat-tools';
import { buildBuilderTools } from './builder-tools';
import { seriesRefusal } from './skill-conflict-followups';
import { skillWriteProblems, type SeriesSourceFact } from './skill-warnings';
import type { ToolContext } from '../harness/tool';

const PROMPT: SeriesSourceFact = { series: 'Prompt', kind: 'library', ref: 'nanobanana_prompts', format: 'photo', brief: 'Промпт для генерації зображень' };
const OLD_PROMPT_SKILL = '# Промпти\nДля кожного промпта став origin=original, джерело PromptHero.';
const CLEAN = '# Стиль\nПиши коротко. Підпис — одне речення, без зайвих слів.';
const META = { description: 'How the channel labels its prompts' };

const store = {
  findShared: async () => null, findForAgent: async () => null,
  writeProblems: async (_a: string, t: { name: string; description: string; body: string }) => skillWriteProblems(t.body, [PROMPT], t),
};

test('seriesRefusal: the series refusal in the tool-error shape; null for a clean text, without a port or when the port fails', async () => {
  const r = await seriesRefusal(store, 'a-1', { name: 'prompt-origin', ...META, body: OLD_PROMPT_SKILL });
  assert.equal(r?.error, 'series_source_conflict');
  assert.match(r!.details, /library:nanobanana_prompts/);
  assert.equal(await seriesRefusal(store, 'a-1', { name: 'prompt-style', ...META, body: CLEAN }), null);
  assert.equal(await seriesRefusal({}, 'a-1', { name: 'prompt-origin', ...META, body: OLD_PROMPT_SKILL }), null);
  assert.equal(await seriesRefusal({ writeProblems: async () => { throw new Error('db gone'); } }, 'a-1', { name: 'x-skill', ...META, body: OLD_PROMPT_SKILL }), null);
});

test('edit_my_skill refuses the old Prompt skill against the series and proposes a clean one', async () => {
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any, memory: { add: async () => 1 } as any, skills: store as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'composer', channelKey: null, extras: { chat: { chatId: 'c', channelKey: '@x' }, agent: { id: 'a-1', handle: 'ai_global', kind: 'orchestrator' }, ownerText: 'x' } } as unknown as ToolContext;
  const input = (body: string) => ({ name: 'prompt-origin', ...META, body });
  assert.equal((await tools.edit_my_skill.execute(input(OLD_PROMPT_SKILL), ctx)).error, 'series_source_conflict');
  assert.equal(proposed.length, 0);
  assert.equal((await tools.edit_my_skill.execute(input(CLEAN), ctx)).ok, true);
  assert.equal(proposed.length, 1);
});

test('the builder\'s write_skill refuses it too', async () => {
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildBuilderTools({
    agents: { getByHandle: async () => ({ id: 'a-1', handle: 'ai_global', kind: 'orchestrator' }), list: async () => [], handleTaken: async () => false } as any,
    catalog: {} as any, profiles: {} as any, creator: {} as any, skills: store as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'builder', channelKey: null, extras: { chat: { chatId: 'c', channelKey: null }, ownerText: 'x' } } as unknown as ToolContext;
  const input = (body: string) => ({ handle: 'ai_global', name: 'prompt-origin', ...META, applies_to: ['composer'], body });
  assert.equal((await tools.write_skill.execute(input(OLD_PROMPT_SKILL), ctx)).error, 'series_source_conflict');
  assert.equal(proposed.length, 0);
  assert.equal((await tools.write_skill.execute(input(CLEAN), ctx)).ok, true);
  assert.equal(proposed.length, 1);
});

test('without the store\'s writeProblems both chat paths behave as before', async () => {
  const proposed: any[] = [];
  const bare = { findShared: async () => null, findForAgent: async () => null };
  const tools = Object.fromEntries(buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any, memory: { add: async () => 1 } as any, skills: bare as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'composer', channelKey: null, extras: { chat: { chatId: 'c', channelKey: '@x' }, agent: { id: 'a-1', handle: 'ai_global', kind: 'orchestrator' }, ownerText: 'x' } } as unknown as ToolContext;
  assert.equal((await tools.edit_my_skill.execute({ name: 'prompt-origin', ...META, body: OLD_PROMPT_SKILL }, ctx)).ok, true);
  assert.equal(proposed.length, 1);
});
