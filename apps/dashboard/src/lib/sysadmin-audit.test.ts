// Spec 055 FR-003: the audit panel's grouping and wording, and the places the new artifact type is wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countsLine, evidenceLines, fixText, groupOpen, handled, isOpen, llmNotice } from './sysadmin-audit';
import type { AuditFinding } from '../api/audits';
import { ARTIFACT_TYPES } from '../api/artifacts';
import { ARTIFACT_META, artifactTone, artifactView, parseArtifactParam } from './artifacts';
import { mentionedArtifacts } from '../components/artifacts/ArtifactChip';
import { MAKE_HINT } from '../components/artifacts/ArtifactList';
import { SLASH_COMMANDS } from '../components/chat/SlashMenu';

const f = (key: string, p: Partial<AuditFinding> = {}): AuditFinding => ({
  key, area: 'skills', check: 'skill_unused', severity: 'info', subject: { type: 'skill', id: key, label: key }, title: `T ${key}`, detail: 'd', evidence: {}, status: 'open', ...p,
});

test('open findings are grouped by area in a fixed order, worst first; applied and dismissed ones are history', () => {
  const list = [
    f('a', { area: 'tools', severity: 'warn' }), f('b', { area: 'skills', severity: 'info' }), f('c', { area: 'skills', severity: 'error' }),
    f('d', { area: 'memory', status: 'applied', at: '2026-10-20T10:00:00Z' }), f('e', { area: 'rules', status: 'dismissed', at: '2026-10-21T10:00:00Z' }),
    f('g', { area: 'prompt', status: 'failed' }),
  ];
  const groups = groupOpen(list);
  assert.deepEqual(groups.map((g) => [g.area, g.findings.map((x) => x.key)]), [['skills', ['c', 'b']], ['tools', ['a']], ['prompt', ['g']]]);
  assert.deepEqual(handled(list).map((x) => x.key), ['e', 'd'], 'newest change first');
  assert.ok(isOpen(f('x', { status: 'failed' })) && !isOpen(f('y', { status: 'applied' })));
});

test('the fix text says what will change, per fix kind', () => {
  assert.match(fixText({ kind: 'skill_disable', agent: 'news', skill: 'poll' }), /Switch the skill poll off for @news/);
  assert.match(fixText({ kind: 'skill_inline_off', agent: 'news', skill: 'poll' }), /load_skill/);
  assert.match(fixText({ kind: 'memory_retire', channel: '@news', id: 7 }), /#7 of @news/);
  assert.match(fixText({ kind: 'conflicts_resolve', agent: 'news' }), /@news/);
});

test('the counts line and the model notice', () => {
  assert.equal(countsLine({ total: 0, open: 0, error: 0, warn: 0, info: 0, fixable: 0 }), 'Nothing to report');
  assert.equal(countsLine({ total: 3, open: 0, error: 0, warn: 0, info: 0, fixable: 0 }), 'Everything is handled');
  assert.equal(countsLine({ total: 4, open: 3, error: 1, warn: 2, info: 0, fixable: 2 }), '1 error · 2 warnings open · 2 with a fix');
  assert.equal(llmNotice({ llm: null }), null);
  assert.equal(llmNotice({ llm: { status: 'ok', note: '', runId: null, costUsd: 0 } }), null);
  assert.match(llmNotice({ llm: { status: 'off', note: '', runId: null, costUsd: 0 } })!, /checks of the code only/);
  assert.equal(llmNotice({ llm: { status: 'failed', note: 'No summary', runId: null, costUsd: 0 } }), 'No summary');
});

test('evidence is shown as short lines, empty values left out', () => {
  const lines = evidenceLines({ calls: 6, empty: '', none: null, text: 'x'.repeat(300), list: ['a', 'b'] });
  assert.deepEqual(lines.slice(0, 2), ['calls: 6', `text: ${'x'.repeat(240)}…`]);
  assert.equal(lines[2], 'list: ["a","b"]');
  assert.equal(lines.length, 3);
});

test('the audit type is known to the registry, the chips, the empty state and the slash menu', () => {
  assert.ok((ARTIFACT_TYPES as readonly string[]).includes('audit'));
  assert.equal(ARTIFACT_META.audit.plural, 'Audits');
  assert.ok(MAKE_HINT.audit.includes('/audit'));
  assert.deepEqual(parseArtifactParam('audit:abc'), { type: 'audit', id: 'abc' });
  assert.deepEqual(mentionedArtifacts('look at [[audit:r1]] please').map((x) => [x.type, x.id]), [['audit', 'r1']]);
  assert.ok(SLASH_COMMANDS.some((c) => c.name === 'audit'));
  assert.equal(artifactTone('done'), 'success');
  assert.equal(artifactView('done'), 'in-use');
  assert.equal(artifactView('failed'), 'closed');
});
