/**
 * Spec 064 FR-009: the weekly audit lints the stored, active owner rules and offers `memory_retire` for each one the
 * lint flags. Fixtures are the three junk rules review 3 found on the stage (#10 a request to the agent, #14 a skill that
 * does not exist, #15 a pointer with no content); fakes only, no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditQueries } from './audit-queries';
import { retireMemoryPort } from './audit-ports';
import { runChecks } from './checks';
import { emptyFacts, type MemoryFact } from './audit.types';
import { lintOwnerRule } from '../agents/rule-lint';

const NOW = new Date('2026-10-26T06:30:00Z');
const row = (p: Partial<MemoryFact>): MemoryFact => ({ id: 1, channel: '@ai0_global', kind: 'rule', text: 'Без хештегів у новинах', createdBy: 'owner', createdAt: NOW, source: null, ...p });

const queries = () => new AuditQueries({
  // The same lint the owner chat runs when a rule is written: skills are checked against a list, agents against handles.
  ruleLint: (text) => lintOwnerRule(text, { skillExists: async (n) => n !== 'poster-bank', handles: ['ai0_global'] }),
} as any);

const FIXTURES: MemoryFact[] = [
  row({ id: 10, text: 'Запамʼятай, що я хочу більше новин про космос' }),
  row({ id: 14, text: 'Для постерів використовуй скіл poster-bank, коли є картинка' }),
  row({ id: 15, text: 'Ці правила завжди виконуються для всіх постів' }),
  row({ id: 16, text: 'Без хештегів у новинах' }),
  row({ id: 17, text: 'Запамʼятай це', source: 'approval' }),
  row({ id: 18, text: 'Ці правила завжди виконуються', createdBy: 'reviewer', kind: 'insight' }),
];

test('stored owner rules that the lint flags become findings with a memory_retire fix; good rules, approval rows and reviewer rows do not', async () => {
  const rules = await queries().rules(FIXTURES, new Map());
  assert.deepEqual(rules.map((r) => r.id), [10, 14, 15, 16], 'only the owner\'s own, non-approval rows are linted');
  const findings = runChecks({ ...emptyFacts(NOW), memory: FIXTURES, rules }).filter((f) => f.check === 'rule_lint');
  assert.deepEqual(findings.map((f) => f.subject.id).sort(), ['@ai0_global#10', '@ai0_global#14', '@ai0_global#15']);
  const by = (id: number) => findings.find((f) => f.subject.id === `@ai0_global#${id}`)!;
  assert.deepEqual(by(10).evidence.codes, ['meta_request']);
  assert.deepEqual(by(14).evidence.codes, ['unknown_skill']);
  assert.deepEqual(by(15).evidence.codes, ['pointer_only']);
  for (const id of [10, 14, 15]) {
    assert.deepEqual(by(id).fix, { kind: 'memory_retire', channel: '@ai0_global', id });
    assert.equal(by(id).area, 'rules');
    assert.match(by(id).detail, /retires this rule/);
  }
  // The same problem has the same key next week, so the report's delta does not call it new.
  const again = runChecks({ ...emptyFacts(NOW), memory: FIXTURES, rules }).filter((f) => f.check === 'rule_lint');
  assert.deepEqual(again.map((f) => f.key).sort(), findings.map((f) => f.key).sort());
});

test('a rule that was fixed (retired) leaves no finding: inactive rows are not in the facts', async () => {
  const rules = await queries().rules(FIXTURES.filter((r) => r.id !== 15), new Map());
  const findings = runChecks({ ...emptyFacts(NOW), rules }).filter((f) => f.check === 'rule_lint');
  assert.deepEqual(findings.map((f) => f.subject.id).sort(), ['@ai0_global#10', '@ai0_global#14']);
});

test('the memory_retire port retires an owner row after a reviewer row is refused; false when neither is active', async () => {
  const calls: string[] = [];
  const port = (reviewer: boolean, owner: boolean) => retireMemoryPort({
    retireByReviewer: async () => { calls.push('reviewer'); return reviewer; },
    retireByOwner: async () => { calls.push('owner'); return owner; },
  });
  assert.equal(await port(true, false)('@c', 1), true);
  assert.deepEqual(calls, ['reviewer']);
  calls.length = 0;
  assert.equal(await port(false, true)('@c', 2), true);
  assert.deepEqual(calls, ['reviewer', 'owner']);
  assert.equal(await port(false, false)('@c', 3), false);
});
