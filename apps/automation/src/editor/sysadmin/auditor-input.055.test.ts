import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditInput, INPUT_CHARS, ITEM_CHARS, MAX_EXTRA, sanitizeSubmission, SubmitAuditInput } from './auditor-input';
import { emptyFacts, type Finding, type SkillFact } from './audit.types';

const NOW = new Date('2026-10-20T06:30:00Z');
const skill = (id: string, name: string, body: string): SkillFact => ({
  id, name, scope: 'global', agent: null, description: `Description of ${name}`, appliesTo: ['executor'], body, safety: false, locked: false,
});
const finding = (p: Partial<Finding> = {}): Finding => ({
  key: 'k1', area: 'skills', check: 'skill_unknown_tool', severity: 'warn',
  subject: { type: 'skill', id: 's1', label: 'format-a' }, title: 'Skill names a tool that does not exist', detail: 'd', evidence: {}, ...p,
});
const parse = (x: unknown) => SubmitAuditInput.parse(x);

test('the input lists the findings, flagged texts first, each clipped, and the whole within the cap', () => {
  const big = 'слово '.repeat(2000);
  const facts = { ...emptyFacts(NOW), skills: [skill('s1', 'format-a', big), ...Array.from({ length: 40 }, (_, i) => skill(`x${i}`, `other-${i}`, big))] };
  const input = buildAuditInput([finding()], facts);
  assert.ok(input.text.length <= INPUT_CHARS);
  assert.match(input.text, /\[k1\] warn skills\/skill_unknown_tool/);
  const lines = input.text.split('\n').filter((l) => l.startsWith('- s1 ') || l.startsWith('- x'));
  assert.ok(lines[0].startsWith('- s1 '), 'the flagged skill comes first');
  assert.ok(lines.every((l) => l.length < ITEM_CHARS + 120), 'texts are clipped');
  assert.ok(lines.length <= 11, 'the flagged one and the ten largest');
  assert.ok(input.allowed.keys.has('k1'));
  assert.ok(input.allowed.subjects.has('s1') && input.allowed.subjects.has('x0'));
  assert.ok(!input.allowed.subjects.has('x20'), 'a text the model was not shown is not a valid subject');
});

test('an empty audit still gives a valid input', () => {
  const input = buildAuditInput([], emptyFacts(NOW));
  assert.match(input.text, /немає/);
  assert.equal(input.allowed.keys.size, 0);
});

test('sanitize: unknown keys and subjects are dropped, texts clipped, enums checked, extras never carry a fix', () => {
  const input = buildAuditInput([finding()], { ...emptyFacts(NOW), skills: [skill('s1', 'format-a', 'body')] });
  const s = sanitizeSubmission(parse({
    summary: 'x'.repeat(900),
    comments: [{ key: 'k1', comment: 'y'.repeat(900) }, { key: 'k1', comment: 'again' }, { key: 'nope', comment: 'invented' }],
    extra: [
      { subject: 's1', area: 'skills', severity: 'ERROR', title: 'Contradicts a rule', detail: 'Both sides named.' },
      { subject: 's1', area: 'skills', severity: 'whatever', title: 'Another one', detail: 'Detail.' },
      { subject: 'ghost', area: 'skills', severity: 'warn', title: 'Invented subject', detail: 'd' },
      { subject: 's1', area: 'weather', severity: 'warn', title: 'Bad area', detail: 'd' },
      { subject: 's1', area: 'skills', severity: 'warn', title: '', detail: 'no title' },
      { subject: 's1', area: 'skills', severity: 'warn', title: 'Contradicts a rule', detail: 'same title twice' },
    ],
  }), input.allowed);
  assert.equal(s.summary.length <= 601, true);
  assert.deepEqual(Object.keys(s.comments), ['k1']);
  assert.ok(s.comments.k1.length <= 401);
  assert.equal(s.extra.length, 2);
  assert.deepEqual(s.extra.map((e) => e.severity), ['error', 'info']);
  assert.ok(s.extra.every((e) => e.check === 'llm_judgement' && !e.fix && /^[0-9a-f]{16}$/.test(e.key)));
  assert.deepEqual(s.dropped, { comments: 2, extra: 4 });
});

test('sanitize: at most 8 own findings', () => {
  const input = buildAuditInput([finding()], { ...emptyFacts(NOW), skills: [skill('s1', 'format-a', 'body')] });
  const extra = Array.from({ length: 12 }, (_, i) => ({ subject: 's1', area: 'skills', severity: 'info', title: `Problem ${i}`, detail: 'd' }));
  const s = sanitizeSubmission(parse({ summary: 'ok', extra }), input.allowed);
  assert.equal(s.extra.length, MAX_EXTRA);
  assert.equal(s.dropped.extra, 4);
});
