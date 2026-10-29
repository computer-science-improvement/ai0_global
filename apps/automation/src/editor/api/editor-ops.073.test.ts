/**
 * Spec 073 FR-012: the memory form (`EditorOpsService.addMemory`) lints a rule or an avoid with the Rules artifact's lint and
 * answers 400 `rule_invalid` on issues; an insight is not linted; the conflicts the new entry causes come back with the id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { EditorOpsService, type EditorOpsDeps } from './editor-ops.service';
import { lintOwnerRule } from '../agents/rule-lint';
import { makeCard } from '../post/testing/fixtures';
import type { ConflictNote } from '../rules/config-conflicts';

function setup(over: Partial<EditorOpsDeps> = {}) {
  const added: Array<{ key: string; kind: string; text: string }> = [];
  let nextId = 40;
  const d = {
    channels: { get: async (k: string) => (k === '@chan' ? { ...makeCard(), createdAt: new Date() } : null) },
    memory: { add: async (key: string, kind: string, text: string) => { added.push({ key, kind, text }); return ++nextId; } },
    lint: (text: string) => lintOwnerRule(text),
    ...over,
  } as unknown as EditorOpsDeps;
  return { svc: new EditorOpsService(d), added };
}

test('a rule that says nothing is refused with 400 rule_invalid, and nothing is stored', async () => {
  const { svc, added } = setup();
  await assert.rejects(svc.addMemory('@chan', { kind: 'rule', text: 'Ці правила завжди виконуються для всіх постів' }), (e: any) => {
    assert.ok(e instanceof BadRequestException);
    assert.equal(e.getStatus(), 400);
    const body = e.getResponse() as { error: string; details: string[] };
    assert.equal(body.error, 'rule_invalid');
    assert.ok(Array.isArray(body.details) && body.details.length === 1);
    assert.match(body.details[0], /points at other text/);
    return true;
  });
  await assert.rejects(svc.addMemory('@chan', { kind: 'avoid', text: 'Запамʼятай це' }), (e: any) => e.getResponse().error === 'rule_invalid');
  assert.deepEqual(added, []);
});

test('an unknown skill or agent in a rule is refused the same way', async () => {
  const lint = (text: string) => lintOwnerRule(text, { skillExists: async () => false, handles: ['ai0_global'] });
  const { svc, added } = setup({ lint });
  await assert.rejects(svc.addMemory('@chan', { kind: 'rule', text: 'Завжди дивись скіл poster-bank перед постом' }), (e: any) => /no such skill: poster-bank/.test(e.getResponse().details[0]));
  await assert.rejects(svc.addMemory('@chan', { kind: 'rule', text: 'Питай @nobody_here про тему дня' }), (e: any) => /no such agent/.test(e.getResponse().details[0]));
  assert.deepEqual(added, []);
});

test('a good rule is stored and the answer is {id} as before; an insight is not linted', async () => {
  const { svc, added } = setup();
  assert.deepEqual(await svc.addMemory('@chan', { kind: 'rule', text: 'Без хештегів у кінці поста' }), { id: 41 });
  assert.deepEqual(await svc.addMemory('@chan', { kind: 'insight', text: 'так' + '.' }), { id: 42 });
  assert.deepEqual(added.map((a) => [a.kind, a.text]), [['rule', 'Без хештегів у кінці поста'], ['insight', 'так.']]);
});

test('without a lint the form stores as it did', async () => {
  const { svc, added } = setup({ lint: undefined });
  assert.deepEqual(await svc.addMemory('@chan', { kind: 'rule', text: 'Ці правила завжди виконуються для всіх постів' }), { id: 41 });
  assert.equal(added.length, 1);
});

test('the conflicts the new rule causes come back; the ones the channel already had do not', async () => {
  const known: ConflictNote = { code: 'hashtag_min_without_vocabulary', ref: 'telegram:@chan', detail: 'hashtag_min is 1 but the card has no hashtags' } as ConflictNote;
  const fresh: ConflictNote = { code: 'hashtags_off_playbook', ref: 'telegram:@chan', detail: 'rule #41 turns hashtags off, the playbook still asks for them' } as ConflictNote;
  let stored = false;
  const { svc } = setup({
    memory: { add: async () => { stored = true; return 41; } } as any,
    conflicts: async () => (stored ? [known, fresh] : [known]),
  });
  const r = await svc.addMemory('@chan', { kind: 'rule', text: 'Без хештегів у кінці поста' });
  assert.deepEqual(r, { id: 41, conflicts: [{ code: 'hashtags_off_playbook', ref: 'telegram:@chan', detail: fresh.detail }] });
});

test('a conflict that names the new rule is reported even when its code was there before', async () => {
  const had: ConflictNote = { code: 'language_check_rule', ref: 'telegram:@chan', detail: 'rule #7 turns the language check off' };
  const named: ConflictNote = { code: 'language_check_rule', ref: 'telegram:@chan', detail: 'rule #41 turns the language check off', rule_id: 41 };
  let stored = false;
  const { svc } = setup({
    memory: { add: async () => { stored = true; return 41; } } as any,
    conflicts: async () => (stored ? [named] : [had]),
  });
  const r = await svc.addMemory('@chan', { kind: 'avoid', text: 'Не перевіряй мову постів' });
  assert.deepEqual((r as any).conflicts.map((c: ConflictNote) => c.detail), ['rule #41 turns the language check off']);
});

test('insights are not checked for conflicts, and a failing conflicts read never stops the rule', async () => {
  let reads = 0;
  const { svc } = setup({ conflicts: async () => { reads++; throw new Error('db gone'); } });
  assert.deepEqual(await svc.addMemory('@chan', { kind: 'rule', text: 'Без хештегів у кінці поста' }), { id: 41 });
  assert.equal(reads, 2, 'before and after for a rule');
  reads = 0;
  assert.deepEqual(await svc.addMemory('@chan', { kind: 'insight', text: 'Люди люблять короткі пости' }), { id: 42 });
  assert.equal(reads, 0);
});
