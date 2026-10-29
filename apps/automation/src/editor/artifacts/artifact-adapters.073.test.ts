/**
 * Spec 073 FR-012: the Rules artifact's `edit` returns `conflicts` (those the edit caused, not those the channel had); the skill
 * artifact refuses an agent's change at `check` for what the store would refuse it for, and an owner's `edit` returns the warnings
 * the store gave; `applyOwnerRule` lints again at Apply and returns `conflicts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesAdapter, skillAdapter, type AdapterEdit } from './artifact-adapters';
import { ArtifactsService } from './artifacts.service';
import { applyOwnerRule } from '../agents/agent-chat-tools';
import { lintOwnerRule } from '../agents/rule-lint';
import { skillWriteProblems, type SeriesSourceFact } from '../agents/skill-warnings';
import type { ConflictNote } from '../rules/config-conflicts';
import type { MemoryRow } from '../repo/editor-memory.repository';

const CH = '@chan';
const dir = { byId: new Map(), byHandle: new Map(), byRef: new Map() } as any;
const fail = (r: AdapterEdit) => { assert.ok(!r.ok, 'expected a refusal'); return r as Extract<AdapterEdit, { ok: false }>; };

function rulesSetup(over: { conflicts?: (key: string) => Promise<ConflictNote[]>; lint?: (t: string, k: string) => Promise<Array<{ code: string; detail: string }>> } = {}) {
  let id = 10;
  const rows: MemoryRow[] = [{ id: 7, channelKey: CH, kind: 'rule', text: 'Старе правило про тон', evidence: null, createdBy: 'owner', createdAt: new Date(), active: true } as unknown as MemoryRow];
  const memory = {
    listAll: async () => rows,
    add: async (_k: string, kind: string, text: string) => { rows.push({ id: ++id, channelKey: CH, kind, text, evidence: null, createdBy: 'owner', createdAt: new Date(), active: true } as unknown as MemoryRow); return id; },
    retireByOwner: async (_k: string, i: number) => { const r = rows.find((x) => x.id === i); if (r) r.active = false; return !!r; },
  };
  const versions = { record: async () => 1, latest: async () => 1, latestMany: async () => new Map(), list: async () => [], body: async () => undefined } as any;
  const adapter = rulesAdapter({ pool: { query: async () => ({ rows: [] }) } as any, memory, versions, lint: over.lint ?? ((t) => lintOwnerRule(t)), conflicts: over.conflicts });
  return { adapter, rows };
}
const by = { author: 'owner' as const };

test('the Rules artifact edit returns no `conflicts` when the channel already had every conflict', async () => {
  const known: ConflictNote = { code: 'hashtag_min_without_vocabulary', ref: 'telegram:@chan', detail: 'hashtag_min is 1 but the card has no hashtags' };
  const s = rulesSetup({ conflicts: async () => [known] });
  assert.deepEqual(await s.adapter.edit!(CH, { add: ['Пиши сленгом для молоді'] }, by, dir), { ok: true });
});

test('conflicts that appear between the two reads come back', async () => {
  const fresh: ConflictNote = { code: 'slang_in_tone', ref: 'telegram:@chan', detail: 'rule #11 asks for slang, the profile tone forbids it' };
  let reads = 0;
  const s = rulesSetup({ conflicts: async () => (reads++ === 0 ? [] : [fresh]) });
  const r = await s.adapter.edit!(CH, { add: ['Пиши сленгом для молоді'] }, by, dir);
  assert.deepEqual(r, { ok: true, conflicts: [{ code: 'slang_in_tone', ref: 'telegram:@chan', detail: fresh.detail }] });
  assert.equal(reads, 2);
});

test('a conflict that names a rule the edit wrote is reported even if its code was there before; an edit counts as a write', async () => {
  const named: ConflictNote = { code: 'language_check_rule', ref: 'telegram:@chan', detail: 'rule #11 turns the language check off', rule_id: 11 };
  const had: ConflictNote = { code: 'language_check_rule', ref: 'telegram:@chan', detail: 'rule #7 turns the language check off', rule_id: 7 };
  let reads = 0;
  const s = rulesSetup({ conflicts: async () => (reads++ === 0 ? [had] : [named]) });
  const r = await s.adapter.edit!(CH, { edit: [{ id: 7, text: 'Не перевіряй мову постів' }] }, by, dir);
  assert.ok(r.ok);
  assert.deepEqual((r as any).conflicts.map((c: ConflictNote) => c.detail), ['rule #11 turns the language check off']);
});

test('without the conflicts port the edit is {ok:true} as before, and a failing read never stops the edit', async () => {
  const a = rulesSetup();
  assert.deepEqual(await a.adapter.edit!(CH, { add: ['Без хештегів у кінці поста'] }, by, dir), { ok: true });
  const b = rulesSetup({ conflicts: async () => { throw new Error('db gone'); } });
  assert.deepEqual(await b.adapter.edit!(CH, { add: ['Без хештегів у кінці поста'] }, by, dir), { ok: true });
});

test('ArtifactsService.edit passes the conflicts and warnings of the adapter on, and patch() returns them beside the detail', async () => {
  const detail = { row: { type: 'rules', id: CH, version: 2, status: 'active' }, body: {}, versions: [], actions: [] };
  const adapter = {
    type: 'rules', list: async () => [], get: async () => ({ row: detail.row, body: {} }), versions: async () => [], version: async () => undefined, actions: () => [],
    edit: async () => ({ ok: true, conflicts: [{ code: 'slang_in_tone', ref: 'x', detail: 'd' }], warnings: ['w'] }),
  } as any;
  const svc = new ArtifactsService({ pool: { query: async () => ({ rows: [] }) } as any, adapters: [adapter] } as any);
  const done = await svc.edit('rules', CH, { add: ['x'] }, { author: 'owner' });
  assert.ok(done.ok);
  assert.deepEqual([(done as any).conflicts, (done as any).warnings], [[{ code: 'slang_in_tone', ref: 'x', detail: 'd' }], ['w']]);
  const patched = await svc.patch('rules', CH, { patch: { add: ['x'] } });
  assert.deepEqual((patched as any).conflicts, [{ code: 'slang_in_tone', ref: 'x', detail: 'd' }]);
});

// ── skills ──────────────────────────────────────────────────────────────────

const PROMPT: SeriesSourceFact = { series: 'Prompt', kind: 'library', ref: 'nanobanana_prompts', format: 'photo', brief: 'Промпт для генерації зображень' };
const OLD_PROMPT_SKILL = '# Промпти\nДля кожного промпта став origin=original, джерело PromptHero.';

function skillSetup() {
  const skill = { id: 's1', name: 'prompt-origin', scope: 'agent', agentId: 'a1', description: 'How prompts are labelled', appliesTo: ['executor'], body: 'Пиши коротко.' };
  const writes: any[] = [];
  const skills = {
    get: async () => skill,
    versions: async () => [],
    writeProblems: async (_a: string, t: { name: string; description: string; body: string }) => skillWriteProblems(t.body, [PROMPT], t),
    writeAgentSkill: async (i: any) => {
      writes.push(i);
      const problems = skillWriteProblems(i.body, [PROMPT], i);
      if (i.author === 'agent' && problems[0]) return problems[0].refusal;
      return { ok: true, skill, version: 2, lint: { ok: true, errors: [], warnings: [] }, ...(problems.length ? { warnings: problems.map((p) => ({ code: p.code, message: p.warning })) } : {}) };
    },
  };
  return { adapter: skillAdapter({ pool: { query: async () => ({ rows: [] }) } as any, skills: skills as any }), writes };
}

test('the skill artifact refuses an agent\'s change at check; a clean change passes', async () => {
  const { adapter } = skillSetup();
  const bad = fail(await adapter.check!('s1', { body: OLD_PROMPT_SKILL }));
  assert.equal(bad.error, 'series_source_conflict');
  assert.match(String(bad.details), /library:nanobanana_prompts/);
  assert.deepEqual(await adapter.check!('s1', { body: 'Пиши коротко, одне речення.' }), { ok: true });
  assert.equal(fail(await adapter.check!('s1', { body: '' })).error, 'invalid_body');
});

test('the skill artifact: the agent\'s edit is refused by the store, the owner\'s is saved and returns the warnings', async () => {
  const { adapter } = skillSetup();
  const agent = fail(await adapter.edit!('s1', { body: OLD_PROMPT_SKILL }, { author: 'agent', agentId: 'a2' }, dir));
  assert.equal(agent.error, 'series_source_conflict');
  const owner = await adapter.edit!('s1', { body: OLD_PROMPT_SKILL }, { author: 'owner' }, dir);
  assert.ok(owner.ok);
  assert.equal((owner as any).warnings.length, 1);
  assert.match((owner as any).warnings[0], /^The skill contradicts a series: /);
  assert.deepEqual(await adapter.edit!('s1', { body: 'Пиши коротко, одне речення.' }, { author: 'owner' }, dir), { ok: true });
});

// ── the Apply of an owner_rule card ─────────────────────────────────────────

const payload = { channel: CH, kind: 'rule', text: 'Без хештегів у кінці поста', quotes: ['без хештегів'] };

test('applyOwnerRule lints again at Apply: a rule that has gone bad fails the card and stores nothing', async () => {
  const added: unknown[] = [];
  const memory = { add: async (...a: unknown[]) => { added.push(a); return 5; } };
  const lint = (text: string) => lintOwnerRule(text, { skillExists: async () => false });
  await assert.rejects(applyOwnerRule(memory, { ...payload, text: 'Завжди дивись скіл poster-bank перед постом' }, { lint }), /^Error: rule_invalid: unknown_skill: no such skill: poster-bank/);
  assert.deepEqual(added, []);
  const ok = await applyOwnerRule(memory, payload, { lint });
  assert.deepEqual(ok, { id: 5, channel: CH });
});

test('applyOwnerRule returns the conflicts the rule caused, and behaves as before without checks', async () => {
  const fresh: ConflictNote = { code: 'hashtags_off_playbook', ref: 'telegram:@chan', detail: 'rule #5 turns hashtags off, the playbook still asks for them' };
  let stored = false;
  const memory = { add: async () => { stored = true; return 5; } };
  const r = await applyOwnerRule(memory, payload, { conflicts: async () => (stored ? [fresh] : []) });
  assert.deepEqual(r, { id: 5, channel: CH, conflicts: [{ code: 'hashtags_off_playbook', ref: 'telegram:@chan', detail: fresh.detail }] });
  assert.deepEqual(await applyOwnerRule({ add: async () => 6 }, payload), { id: 6, channel: CH });
  await assert.rejects(applyOwnerRule({ add: async () => 7 }, { channel: CH, text: 'коротко' }), /invalid_rule/);
});
