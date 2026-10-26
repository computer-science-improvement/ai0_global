import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillConflicts } from './skill-warnings';
import { conflictFollowUps, conflictsLine } from './skill-conflict-followups';
import { buildAgentChatTools } from './agent-chat-tools';
import { buildBuilderTools } from './builder-tools';
import { PendingActionsService, type PendingAction } from './pending-actions';
import type { ToolContext } from '../harness/tool';

/** Spec 069 FR-003 / A7: the skills a new skill contradicts are found when it is written, and ride on its card. */

// The review-4 pair (stage export, channel @ai_global): the first stayed on after the second was added.
const FILTER = '# Джерело промптів\nФільтр provider=prompthero: бери лише рядки цього провайдера, інші рядки датасету пропускай.';
const DROPPED = '# Джерела\nPromptHero не використовую. Промпти беремо з іншого місця.';

test('review 4: «PromptHero не використовую» against «Фільтр provider=prompthero» is a hard conflict, both ways round', () => {
  const asNew = skillConflicts(DROPPED, [{ name: 'prompthero-filter', body: FILTER }]);
  assert.deepEqual(asNew.map((c) => [c.name, c.kind, c.tokens]), [['prompthero-filter', 'hard', ['prompthero']]]);
  assert.match(asNew[0].reason, /tells the agent to use "prompthero".*rules out/);

  const reverse = skillConflicts(FILTER, [{ name: 'prompthero-dropped', body: DROPPED }]);
  assert.deepEqual(reverse.map((c) => [c.name, c.kind, c.tokens]), [['prompthero-dropped', 'hard', ['prompthero']]]);
  assert.match(reverse[0].reason, /rules out "prompthero".*new skill tells the agent to use/);
});

test('hosts are compared by their second-level label, with or without the scheme', () => {
  const uses = 'Бери промпти з https://www.prompthero.com/feed щодня.';
  assert.equal(skillConflicts('Ніколи не бери промпти з prompthero.com.', [{ name: 'a', body: uses }])[0]?.kind, 'hard');
  assert.equal(skillConflicts('Never use https://bbc.co.uk for news.', [{ name: 'a', body: 'Take stories from bbc.co.uk every morning.' }])[0]?.kind, 'hard', 'bbc.co.uk → bbc');
  assert.equal(skillConflicts('Писати у стилі «skill.md» без e.g. прикладів, не використовуй емодзі.', [{ name: 'a', body: uses }]).length, 0, 'file names and abbreviations are not hosts');
});

test('a data:// or library: key is a source; a negated first part of the key rules it out', () => {
  const uses = 'Рядки беремо з library:nanobanana_prompts, по одному на пост.';
  assert.deepEqual(skillConflicts('Не використовуй nanobanana.', [{ name: 'a', body: uses }]).map((c) => c.kind), ['hard']);
  assert.deepEqual(skillConflicts('Рядки з data://nanobanana_prompts не бери.', [{ name: 'a', body: uses }]).map((c) => c.kind), ['hard']);
  assert.equal(skillConflicts('Не використовуй banana.', [{ name: 'a', body: uses }]).length, 0, 'a word that is only a piece of the key is not a match');
});

test('the same source in both, or the same source ruled out in both, is no conflict', () => {
  assert.deepEqual(skillConflicts('Фільтр provider=prompthero для всіх промптів.', [{ name: 'a', body: FILTER }]), []);
  assert.deepEqual(skillConflicts('PromptHero не використовую.', [{ name: 'a', body: DROPPED }]), []);
});

test('a negation that is not about taking or using does not turn a source into a ruled-out one', () => {
  const body = 'Фільтр provider=prompthero. Не переписуй промпт, не змінюй автора.';
  assert.deepEqual(skillConflicts('Не переписуй текст і не додавай емодзі.', [{ name: 'a', body }]), []);
  // …and inside the skill itself, the provider stays a positive source.
  assert.equal(skillConflicts('PromptHero не використовую.', [{ name: 'a', body }])[0]?.kind, 'hard');
});

test('two skills that name different sources for the same format are a soft conflict; different formats are not', () => {
  const a = '# Промпти\nПромпти беремо з provider=nanobanana, один на пост.';
  const b = '# Промпти дня\nФільтр provider=prompthero для промптів.';
  const soft = skillConflicts(a, [{ name: 'prompts-prompthero', description: 'Промпти з PromptHero', body: b }], { name: 'prompts-nanobanana', description: 'Промпти з nanobanana' });
  assert.deepEqual(soft.map((c) => [c.name, c.kind]), [['prompts-prompthero', 'soft']]);
  assert.ok(soft[0].tokens.includes('prompt'));
  assert.match(soft[0].reason, /other sources/);

  const recipe = '# Рецепти\nРецепти беремо з https://example.com/feed.';
  assert.deepEqual(skillConflicts(a, [{ name: 'recipes', description: 'Рецепти', body: recipe }], { name: 'prompts-nanobanana' }), []);
});

test('hard conflicts come before soft ones; the skill with the same name is never compared with itself; style skills never conflict', () => {
  const out = skillConflicts('# Промпти\nПромпти з provider=nanobanana. PromptHero не використовую.', [
    { name: 'prompts-other', description: 'Промпти', body: 'Промпти беремо з provider=civitai.' },
    { name: 'prompthero-filter', body: FILTER },
    { name: 'same-name', body: FILTER },
    { name: 'style', body: 'Пиши коротко, без емодзі. Перший рядок — гачок.' },
  ], { name: 'same-name', description: 'Промпти' });
  assert.deepEqual(out.map((c) => [c.name, c.kind]), [['prompthero-filter', 'hard'], ['prompts-other', 'soft']]);
});

// ── The follow-ups: who is a candidate, who owns the skill, hard ticked / soft unticked ─────────────────────────────────

const ORCH = { id: 'a-orch', handle: 'ai_global', kind: 'orchestrator', parentId: null } as any;
const EXEC = { id: 'a-exec', handle: 'ai_global_executor', kind: 'executor', parentId: 'a-orch' } as any;
const entry = (name: string, body: string, o: { agentId?: string | null; enabled?: boolean; safety?: boolean; origin?: string; appliesTo?: string[]; description?: string } = {}) => ({
  skill: { name, body, agentId: o.agentId === undefined ? 'a-orch' : o.agentId, safety: !!o.safety, appliesTo: o.appliesTo ?? ['executor', 'composer', 'checker'], description: o.description ?? '' },
  enabled: o.enabled ?? true, origin: o.origin ?? 'own',
});
const deps = (entries: any[]) => ({
  agents: { children: async () => [EXEC], get: async (id: string) => (id === 'a-orch' ? ORCH : null) } as any,
  skills: { listForAgent: async (chain: string[]) => { assert.deepEqual(chain, ['a-orch', 'a-exec']); return entries; } } as any,
});

test('conflictFollowUps: candidates are enabled, own or inherited, not builtin, safety or protected, not the written skill; the owner handle is the skill\'s own agent', async () => {
  const d = deps([
    entry('prompthero-filter', FILTER, { agentId: 'a-exec' }),
    entry('builtin-one', FILTER, { origin: 'builtin', agentId: null }),
    entry('safety-one', FILTER, { safety: true }),
    entry('anti-slop', FILTER),
    entry('switched-off', FILTER, { enabled: false }),
    entry('wrong-role', FILTER, { appliesTo: ['planner'] }),
    entry('shared-global', FILTER, { agentId: null, origin: 'global' }),
  ]);
  const found = await conflictFollowUps(d, ORCH, { name: 'dropped', body: DROPPED, appliesTo: ['composer'] });
  assert.deepEqual(found.then.map((t) => [t.key, t.kind, t.payload]), [
    ['detach:prompthero-filter', 'detach_skill', { handle: 'ai_global_executor', skill: 'prompthero-filter' }],
    ['detach:shared-global', 'detach_skill', { handle: 'ai_global', skill: 'shared-global' }],
  ]);
  assert.ok(found.then.every((t) => t.ticked === undefined), 'hard conflicts are ticked');
  assert.match(found.then[0].summary, /^Disable skill "prompthero-filter" for @ai_global_executor: /);
});

test('conflictFollowUps: a role agent compares over its orchestrator\'s family; soft items start unticked; skip and limit are kept', async () => {
  const d = deps([
    entry('prompts-prompthero', 'Промпти беремо з provider=prompthero.', { description: 'Промпти' }),
    entry('civitai-filter', 'Фільтр provider=civitai для промптів.'),
  ]);
  const NEW = 'Промпти беремо з provider=nanobanana. Civitai не використовую.';
  const written = { name: 'prompts-nano', description: 'Промпти', body: NEW };
  const found = await conflictFollowUps(d, EXEC, written);
  assert.deepEqual(found.then.map((t) => [t.key, t.ticked]), [['detach:civitai-filter', undefined], ['detach:prompts-prompthero', false]], 'hard first, soft unticked');

  const skipped = await conflictFollowUps(d, ORCH, written, { skip: new Set(['detach:civitai-filter']) });
  assert.deepEqual(skipped.then.map((t) => t.key), ['detach:prompts-prompthero'], 'an item already on the card is not added twice');
  const limited = await conflictFollowUps(d, EXEC, written, { limit: 1 });
  assert.deepEqual(limited.then.map((t) => t.key), ['detach:civitai-filter'], 'the hard one survives a cut');
  assert.equal((await conflictFollowUps(d, ORCH, written, { limit: 0 })).then.length, 0);
});

test('conflictFollowUps: a failing lookup never stops the card, and without the family nothing is looked for', async () => {
  const broken = await conflictFollowUps({ agents: { children: async () => { throw new Error('db down'); } } as any, skills: { listForAgent: async () => [] } as any }, ORCH, { body: DROPPED });
  assert.deepEqual([broken.then, broken.error], [[], 'db down']);
  assert.deepEqual(await conflictFollowUps({}, ORCH, { body: DROPPED }), { then: [], conflicts: [] });
});

test('conflictsLine says what rides on the card', () => {
  assert.equal(conflictsLine([]), '');
  const line = conflictsLine([
    { key: 'detach:a', kind: 'detach_skill', payload: { skill: 'a' }, summary: '' },
    { key: 'detach:b', kind: 'detach_skill', payload: { skill: 'b' }, summary: '', ticked: false },
  ]);
  assert.match(line, /Also disables the conflicting skill "a"\./);
  assert.match(line, /Suggested, unticked: "b"\./);
});

// ── In the tools ─────────────────────────────────────────────────────────────────────────────────────────────────────

const STYLE = '# Джерела\nPromptHero не використовую. Вказуй автора й посилання на оригінал з полів рядка датасету, промпт залишай дослівно.';

test('edit_my_skill: the contradicting skill rides on the write_skill card as a ticked detach_skill', async () => {
  const proposed: any[] = [];
  const tools = Object.fromEntries(buildAgentChatTools({
    pool: { query: async () => ({ rows: [] }) } as any, memory: { add: async () => 1 } as any,
    skills: { findShared: async () => null, ...deps([entry('prompthero-filter', FILTER)]).skills } as any,
    agents: deps([]).agents,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'composer', channelKey: null, extras: { chat: { chatId: 'c', channelKey: '@ai_global' }, agent: ORCH, ownerText: 'x' } } as unknown as ToolContext;

  const out = await tools.edit_my_skill.execute({ name: 'prompt-sources', description: 'Which prompts are not used any more', body: STYLE }, ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0].payload.then, [{
    key: 'detach:prompthero-filter', kind: 'detach_skill', payload: { handle: 'ai_global', skill: 'prompthero-filter' },
    summary: proposed[0].payload.then[0].summary,
  }]);
  assert.match(proposed[0].summary, /Also disables the conflicting skill "prompthero-filter"\./);
  assert.deepEqual(out.conflicts.map((c: any) => [c.skill, c.kind]), [['prompthero-filter', 'hard']]);
  assert.match(out.conflicts_note, /Скажи власнику/);

  // A skill that contradicts nothing is the plain card.
  proposed.length = 0;
  const plain = await tools.edit_my_skill.execute({ name: 'voice-notes', description: 'How the channel sounds', body: '# Голос\nПиши коротко, без емодзі. Перший рядок — гачок, далі два речення.' }, ctx);
  assert.equal(plain.ok, true);
  assert.equal('then' in proposed[0].payload, false);
  assert.equal(plain.conflicts, undefined);
});

test('the builder\'s write_skill attaches them too; without the family (old wiring) nothing changes', async () => {
  const proposed: any[] = [];
  const build = (withFamily: boolean) => Object.fromEntries(buildBuilderTools({
    agents: { getByHandle: async () => ORCH, list: async () => [], handleTaken: async () => false, ...(withFamily ? deps([]).agents : {}) } as any,
    catalog: {} as any, profiles: {} as any, creator: {} as any,
    skills: { findShared: async () => null, findForAgent: async () => null, ...(withFamily ? deps([entry('prompthero-filter', FILTER)]).skills : {}) } as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-1', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = { runId: 'r', role: 'builder', channelKey: null, extras: { chat: { chatId: 'c', channelKey: null }, ownerText: 'x' } } as unknown as ToolContext;
  const input = { handle: 'ai_global', name: 'prompt-sources', description: 'Which prompts are not used any more', applies_to: ['composer'], body: STYLE };

  const out = await build(true).write_skill.execute(input, ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(proposed[0].payload.then.map((t: any) => t.payload), [{ handle: 'ai_global', skill: 'prompthero-filter' }]);
  assert.equal(out.conflicts[0].skill, 'prompthero-filter');

  proposed.length = 0;
  const old = await build(false).write_skill.execute(input, ctx);
  assert.equal(old.ok, true);
  assert.equal('then' in proposed[0].payload, false);
});

test('Apply: the skill is written, then the conflicting one is switched off; an unticked soft one stays', async () => {
  const rows = new Map<string, PendingAction>();
  const repo: any = {
    create: async (a: any) => { const id = `00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, '0')}`; const x = { ...a, id, status: 'pending', result: null, error: null, createdAt: new Date(), decidedAt: null, agentId: a.agentId ?? null }; rows.set(id, x); return x; },
    get: async (id: string) => rows.get(id) ?? null,
    decide: async (id: string, status: any, result?: unknown, error?: string | null) => {
      const x = rows.get(id); if (!x || x.status !== 'pending') return null;
      const u = { ...x, status, result: result ?? null, error: error ?? null, decidedAt: new Date() }; rows.set(id, u); return u;
    },
  };
  const svc = new PendingActionsService(repo);
  const log: string[] = [];
  svc.register('write_skill', async (p) => { log.push(`write:${String(p.name)}`); return { version: 2 }; });
  svc.register('detach_skill', async (p) => { log.push(`detach:${String(p.skill)}`); return { ok: true }; });
  const found = await conflictFollowUps(deps([entry('civitai-filter', 'Фільтр provider=civitai для промптів.'), entry('prompts-prompthero', 'Промпти беремо з provider=prompthero.', { description: 'Промпти' })]),
    ORCH, { name: 'prompts-nano', description: 'Промпти', body: 'Промпти беремо з provider=nanobanana. Civitai не використовую.' });
  assert.equal(found.then.length, 2);
  const card = await svc.propose({ chatId: 'c', kind: 'write_skill', payload: { name: 'prompts-nano', handle: 'ai_global', then: found.then }, summary: 's' });
  const done = await svc.apply(card.id);
  assert.equal(done.status, 'applied');
  assert.deepEqual(log, ['write:prompts-nano', 'detach:civitai-filter'], 'the soft item starts unticked and is not run without the owner\'s tick');
  assert.deepEqual((done.result as any).then.map((t: any) => [t.key, t.ok, t.error ?? null]), [['detach:civitai-filter', true, null], ['detach:prompts-prompthero', false, 'not_ticked']]);

  // The owner ticks the soft one in the dashboard: skip_then is then empty.
  const second = await svc.propose({ chatId: 'c', kind: 'write_skill', payload: { name: 'prompts-nano', handle: 'ai_global', then: found.then }, summary: 's' });
  log.length = 0;
  await svc.apply(second.id, { skip_then: [] });
  assert.deepEqual(log, ['write:prompts-nano', 'detach:civitai-filter', 'detach:prompts-prompthero']);
});
