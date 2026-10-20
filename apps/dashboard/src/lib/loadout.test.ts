import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoadoutSkill, LoadoutSuggestion, LoadoutTool } from '../api/loadout';
import {
  applyBody, applySummary, evidenceLine, fmtChars, groupTools, KIND_LABEL, loadoutErrorText, lockReason, ruleLines, savedPct, skillsSummary, SUGGESTION_LABEL,
  suggestionName, tokensLine, toolsAfterToggle, usageLine,
} from './loadout';

const tool = (name: string, over: Partial<LoadoutTool> = {}): LoadoutTool => ({
  name, kind: 'read', description: `${name} does a thing`, core: false, enabled: true, available: true, tokens: 100,
  calls30d: 0, errors30d: 0, lastUsedAt: null, ...over,
});
const skill = (name: string, over: Partial<LoadoutSkill> = {}): LoadoutSkill => ({
  name, scope: 'builtin', enabled: true, inline: false, loads30d: 0, lastLoadedAt: null, chars: 500, ...over,
});

test('tools are grouped read · act · terminal, sorted by name, empty groups dropped', () => {
  const g = groupTools([
    tool('publish_post', { kind: 'terminal', core: true }), tool('b_tool'), tool('add_memory', { kind: 'act', enabled: false }), tool('a_tool'),
  ]);
  assert.deepEqual(g.map((x) => x.kind), ['read', 'act', 'terminal']);
  assert.deepEqual(g[0].tools.map((t) => t.name), ['a_tool', 'b_tool']);
  assert.deepEqual([g[1].enabled, g[1].tokens], [0, 0]);
  assert.deepEqual([g[0].enabled, g[0].tokens], [2, 200]);
  assert.equal(g[2].label, KIND_LABEL.terminal.label);
  assert.deepEqual(groupTools([tool('x')]).map((x) => x.kind), ['read']);
  assert.deepEqual(groupTools([]), []);
});

test('a toggle is locked for terminal and core tools and for tools the runs always drop', () => {
  assert.match(lockReason(tool('publish_post', { kind: 'terminal' }))!, /always offered/);
  assert.match(lockReason(tool('fetch_feed', { core: true }))!, /core tool/);
  assert.match(lockReason(tool('sql_readonly', { available: false, enabled: false }))!, /always drop/);
  assert.equal(lockReason(tool('get_top_posts')), null);
});

test('the tokens line names the role default only when the loadout is smaller', () => {
  assert.equal(tokensLine({ current: 1240, roleDefault: 3900 }), '~1,240 tokens per call (role default 3,900)');
  assert.equal(tokensLine({ current: 3900, roleDefault: 3900 }), '~3,900 tokens per call (the role default)');
  assert.equal(savedPct({ current: 1240, roleDefault: 3900 }), 68);
  assert.equal(savedPct({ current: 3900, roleDefault: 3900 }), 0);
  assert.equal(savedPct({ current: 0, roleDefault: 0 }), 0);
});

test('usage line: calls, errors and the last use; never-used tools say so', () => {
  assert.equal(usageLine({ calls30d: 0, errors30d: 0, lastUsedAt: null }), 'not used in 30 days');
  assert.equal(usageLine({ calls30d: 1, errors30d: 0, lastUsedAt: new Date().toISOString() }), '1 call · last used just now');
  assert.match(usageLine({ calls30d: 12, errors30d: 2, lastUsedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }), /^12 calls · 2 errors · last used 2d ago$/);
});

test('a toggle sends every enabled tool with the flipped one switched', () => {
  const tools = [tool('a'), tool('b', { enabled: false }), tool('c', { kind: 'terminal', core: true })];
  assert.deepEqual(toolsAfterToggle(tools, 'b', true), ['a', 'b', 'c']);
  assert.deepEqual(toolsAfterToggle(tools, 'a', false), ['c']);
});

test('skills summary: enabled, always in context (with their size) and the ones never loaded', () => {
  const s = skillsSummary([
    skill('a', { inline: true, chars: 1200 }), skill('b', { loads30d: 3 }), skill('z-never'), skill('m-never'), skill('off', { enabled: false }),
    skill('inline-never', { inline: true, chars: 300 }),
  ]);
  assert.deepEqual([s.total, s.enabled, s.inline, s.inlineChars], [6, 5, 2, 1500]);
  assert.deepEqual(s.neverLoaded, ['m-never', 'z-never']);
  assert.deepEqual(skillsSummary([]), { total: 0, enabled: 0, inline: 0, inlineChars: 0, neverLoaded: [] });
});

test('rule lines and sizes', () => {
  const lines = ruleLines({ ownerRules: 1, memory: 12, steeringSets: 0, playbookRules: 3, chars: 4200 });
  assert.deepEqual(lines.map((l) => `${l.label}: ${l.count} ${l.unit}`), [
    'Owner rules: 1 rule', 'Memory: 12 entries', 'Steering: 0 active sets', 'Playbook rules: 3 rules',
  ]);
  assert.equal(fmtChars(4200), '~4.2k chars');
  assert.equal(fmtChars(80), '80 chars');
});

test('server refusals read in plain English', () => {
  assert.match(loadoutErrorText('core_tool', 'x'), /Core tools/);
  assert.equal(loadoutErrorText('something_else', 'raw'), 'raw');
  assert.equal(loadoutErrorText(undefined, 'raw'), 'raw');
});

const sug = (kind: LoadoutSuggestion['kind'], name: string, action: LoadoutSuggestion['action'], evidence: Record<string, number> = {}): LoadoutSuggestion => ({
  id: `${kind}:${name}`, kind, ...(kind === 'skills_unused' ? { skill: name } : { tool: name }), action, reason: 'reason', evidence,
});

test('apply body splits suggestions into tools to add, tools to remove and skills to turn off', () => {
  const list = [sug('missing', 'lint_post', 'add'), sug('peer', 'get_top_posts', 'add'), sug('unused', 'act_x', 'remove'), sug('stale', 'old', 'remove'), sug('skills_unused', 'poll', 'disable')];
  assert.deepEqual(applyBody(list), { add: ['lint_post', 'get_top_posts'], remove: ['act_x', 'old'], disableSkills: ['poll'] });
  assert.deepEqual(applyBody([]), { add: [], remove: [], disableSkills: [] });
  assert.deepEqual(applyBody([list[2]]), { add: [], remove: ['act_x'], disableSkills: [] });
});

test('apply summary names one or two tools and counts more', () => {
  assert.equal(applySummary([sug('missing', 'lint_post', 'add')]), 'add lint_post');
  assert.equal(
    applySummary([sug('unused', 'a', 'remove'), sug('unused', 'b', 'remove'), sug('unused', 'c', 'remove'), sug('skills_unused', 'poll', 'disable')]),
    'remove 3 tools · turn off 1 skill',
  );
  assert.equal(applySummary([]), '');
});

test('evidence lines and labels for every kind', () => {
  assert.equal(evidenceLine(sug('unused', 'x', 'remove', { offered: 12, calls: 0 })), 'offered in 12 runs, 0 calls');
  assert.equal(evidenceLine(sug('missing', 'x', 'add', { denied: 3 })), 'refused 3 times');
  assert.equal(evidenceLine(sug('peer', 'x', 'add', { peerPct: 45, peerRuns: 40 })), '45% of 40 peer runs');
  assert.equal(evidenceLine(sug('skills_unused', 'x', 'disable', { runs: 20 })), '0 loads in 20 runs');
  assert.match(evidenceLine(sug('stale', 'x', 'remove')), /not a tool/);
  assert.deepEqual(Object.keys(SUGGESTION_LABEL).sort(), ['missing', 'peer', 'skills_unused', 'stale', 'unused']);
  assert.equal(suggestionName(sug('skills_unused', 'poll', 'disable')), 'poll');
  assert.equal(suggestionName(sug('unused', 'act_x', 'remove')), 'act_x');
});
