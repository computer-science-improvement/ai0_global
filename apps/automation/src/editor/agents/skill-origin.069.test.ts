import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originRefusal, originWithSource } from './skill-warnings';
import { buildAgentChatTools } from './agent-chat-tools';
import { buildBuilderTools } from './builder-tools';
import type { ToolContext } from '../harness/tool';

/**
 * Spec 069 FR-007: a skill that tells the agent to label material it read from a page, a feed, a document or the library as
 * `origin=original` is refused — the lint (`origin_mismatch`) would reject every post written by it.
 */

test('originWithSource finds origin=original prescribed for read material', () => {
  assert.match(originWithSource('Бери промпт з бібліотеки і став origin=original.')!.sentence, /origin=original/);
  assert.ok(originWithSource('Після web_fetch сторінки пиши пост з origin: original.'));
  assert.ok(originWithSource('Prompts from query_data rows go out as origin=original.'));
  assert.ok(originWithSource('Матеріал з https://example.com/feed — origin = "original".'));
  assert.equal(originWithSource('Публікуй так:\n- став origin=original\n- вкажи автора.'), null, 'the lead line must read material for a list item to count');
  assert.ok(originWithSource('Рядок з бібліотеки публікуй так:\n- став origin=original\n- вкажи автора.'), 'a list item reads its lead line');
});

test('own text, the right pairing, and negations pass', () => {
  assert.equal(originWithSource('# Стиль\nПиши коротко. Для власних дописів став origin=original.'), null);
  assert.equal(originWithSource('Рядок бібліотеки: origin=library та library_ref; власний текст — origin=original.'), null, 'both origins in one sentence');
  assert.equal(originWithSource('Для матеріалу з web_fetch став origin=external і source.url.'), null);
  assert.equal(originWithSource('Ніколи не став origin=original на промпт з бібліотеки.'), null);
  assert.equal(originWithSource('Пост без джерела — origin=original.'), null);
  assert.equal(originWithSource('Keep the prompt verbatim and credit the author.'), null);
});

test('originRefusal is the tool error: a code, the sentence and the way out', () => {
  const e = originRefusal('Бери промпт з бібліотеки і став origin=original.')!;
  assert.equal(e.error, 'origin_original_with_source');
  assert.match(e.details, /origin=original/);
  assert.match(e.details, /origin_mismatch/);
  assert.match(e.hint, /origin=external \+ source\.url/);
  assert.match(e.hint, /origin=library \+ library_ref/);
  assert.equal(originRefusal('Пиши коротко.'), null);
});

const BODY_BAD = '# Промпти\nБери промпт з бібліотеки датасету і публікуй його з origin=original, вказуючи автора.';
const BODY_OK = '# Промпти\nБери промпт з бібліотеки датасету і публікуй його з origin=library та library_ref, вказуючи автора.';

test('edit_my_skill refuses it with origin_original_with_source and proposes the corrected skill', async () => {
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any, memory: { add: async () => 1 } as any,
    skills: { findShared: async () => null } as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'composer', channelKey: null, extras: { chat: { chatId: 'c', channelKey: '@x' }, agent: { id: 'a-1', handle: 'ai_global', kind: 'orchestrator' }, ownerText: 'x' } } as unknown as ToolContext;
  const input = (body: string) => ({ name: 'prompts-origin', description: 'How the channel labels its prompts', body });
  assert.equal((await tools.edit_my_skill.execute(input(BODY_BAD), ctx)).error, 'origin_original_with_source');
  assert.equal(proposed.length, 0);
  assert.equal((await tools.edit_my_skill.execute(input(BODY_OK), ctx)).ok, true);
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
  const input = (body: string) => ({ handle: 'ai_global', name: 'prompts-origin', description: 'How the channel labels its prompts', applies_to: ['composer'], body });
  assert.equal((await tools.write_skill.execute(input(BODY_BAD), ctx)).error, 'origin_original_with_source');
  assert.equal(proposed.length, 0);
  assert.equal((await tools.write_skill.execute(input(BODY_OK), ctx)).ok, true);
});
