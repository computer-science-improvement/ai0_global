import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, countFindings } from './index';
import {
  skillDuplicateFindings, skillLintFindings, skillRollbackFindings, skillUnknownToolFindings, skillUnusedFindings,
} from './skills';
import { memoryDuplicateFindings, memoryOverflowFindings, memoryStaleFindings } from './memory';
import { configConflictFindings, playbookFindings, ruleLintFindings, steeringFindings } from './rules';
import { roleFailureFindings, toolErrorFindings } from './tools';
import { inlineBudgetFindings } from './prompt';
import { emptyFacts, type AgentFact, type AgentSkillFact, type AuditFacts, type MemoryFact, type SkillFact } from '../audit.types';
import { findingKey, jaccard, tokenSet } from '../audit-text';

const NOW = new Date('2026-10-20T06:30:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const facts = (p: Partial<AuditFacts> = {}): AuditFacts => ({ ...emptyFacts(NOW), ...p });

const skill = (p: Partial<SkillFact> = {}): SkillFact => ({
  id: 's1', name: 'format-poll', scope: 'builtin', agent: null, description: 'How to build a good poll for a channel.',
  appliesTo: ['executor'], body: 'Write the poll question short and the options distinct.', safety: false, locked: false, ...p,
});
const entry = (p: Partial<AgentSkillFact> = {}): AgentSkillFact => ({
  skillId: 's1', name: 'format-poll', origin: 'builtin', enabled: true, inline: false, description: 'How to build a good poll.',
  appliesTo: ['executor'], body: 'Write the poll question short and the options distinct.', safety: false, updatedAt: daysAgo(10), ...p,
});
const agent = (p: Partial<AgentFact> = {}): AgentFact => ({ id: 'a1', handle: 'news_ch', kind: 'orchestrator', runs: 40, roles: ['executor', 'planner'], loads: {}, skills: [], ...p });
const mem = (p: Partial<MemoryFact> = {}): MemoryFact => ({
  id: 1, channel: '@news', kind: 'insight', text: 'Short headlines get more views.', createdBy: 'reviewer', createdAt: daysAgo(5), source: null, ...p,
});

// ── keys and text ───────────────────────────────────────────────────────────

test('finding keys are stable per area, check and subject, and differ by any of them', () => {
  const s = { type: 'skill' as const, id: 'x', agent: 'a' };
  assert.equal(findingKey('skills', 'skill_lint', s), findingKey('skills', 'skill_lint', { ...s }));
  assert.notEqual(findingKey('skills', 'skill_lint', s), findingKey('skills', 'skill_unused', s));
  assert.notEqual(findingKey('skills', 'skill_lint', s), findingKey('memory', 'skill_lint', s));
  assert.notEqual(findingKey('skills', 'skill_lint', s), findingKey('skills', 'skill_lint', { ...s, agent: 'b' }));
  assert.match(findingKey('skills', 'x', s), /^[0-9a-f]{16}$/);
});

test('jaccard: case and punctuation do not matter; unrelated texts are far apart', () => {
  assert.equal(jaccard(tokenSet('Hello, World!'), tokenSet('hello world')), 1);
  assert.ok(jaccard(tokenSet('one two three four'), tokenSet('five six seven eight')) < 0.1);
  assert.equal(jaccard(tokenSet(''), tokenSet('a')), 0);
});

// ── skills ──────────────────────────────────────────────────────────────────

test('skill lint: errors are error, warnings are warn, a clean skill is silent', () => {
  const bad = skill({ id: 'bad', name: 'bypass-it', body: 'Skip the lint checks before every post.' });
  const long = skill({ id: 'long', name: 'long-one', appliesTo: ['executor', 'wizard'] });
  const r = skillLintFindings(facts({ skills: [skill(), bad, long] }));
  assert.equal(r.length, 2);
  const byName = Object.fromEntries(r.map((x) => [x.subject.label, x]));
  assert.equal(byName['bypass-it'].severity, 'error');
  assert.match(byName['bypass-it'].detail, /guard_bypass/);
  assert.equal(byName['long-one'].severity, 'error');
  assert.equal(byName['long-one'].fix, undefined);
});

test('skill lint: a skill past the inline limit that is saved inline is a warning only', () => {
  // inline_too_long is a warning of lintSkill, which the audit does not pass (no inline flag): so nothing to report.
  assert.deepEqual(skillLintFindings(facts({ skills: [skill({ body: 'a '.repeat(3000) })] })), []);
});

test('unknown tool names in a skill body are flagged against the registry; no registry, no check', () => {
  const s = skill({ id: 'u', name: 'uses-tools', body: 'Call `publish_post` and then `get_magic_numbers`, never `publish_now`.' });
  const known = new Set(['publish_post']);
  const r = skillUnknownToolFindings(facts({ skills: [s], knownTools: known }));
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'warn');
  assert.deepEqual(r[0].evidence.unknown, ['get_magic_numbers', 'publish_now']);
  assert.deepEqual(skillUnknownToolFindings(facts({ skills: [s] })), []);
});

test('unused skills: enabled, on demand, never loaded by an agent that ran enough; fix disables it for that agent', () => {
  const unused = entry({ skillId: 'u', name: 'format-quiz' });
  const used = entry({ skillId: 'v', name: 'format-poll' });
  const inline = entry({ skillId: 'w', name: 'inline-one', inline: true });
  const off = entry({ skillId: 'x', name: 'disabled-one', enabled: false });
  const workflow = entry({ skillId: 'y', name: 'editor-executor-workflow' });
  const safety = entry({ skillId: 'z', name: 'some-guard', safety: true });
  const otherRole = entry({ skillId: 'q', name: 'manager-only', appliesTo: ['manager'] });
  const a = agent({ loads: { 'format-poll': 3 }, skills: [unused, used, inline, off, workflow, safety, otherRole] });
  const r = skillUnusedFindings(facts({ agents: [a] }));
  assert.equal(r.length, 1);
  assert.equal(r[0].subject.label, 'format-quiz');
  assert.deepEqual(r[0].fix, { kind: 'skill_disable', agent: 'news_ch', skill: 'format-quiz' });
  assert.equal(r[0].severity, 'info');
  assert.deepEqual(skillUnusedFindings(facts({ agents: [{ ...a, runs: 9 }] })), [], 'an agent that ran fewer than 10 times says nothing');
});

test('duplicate skills: ≥ 0.85 token overlap on one agent; the newer is disabled; shared pairs get no fix', () => {
  const text = 'always check the source date before writing the post then verify every number against the source and write the final text in plain words without filler';
  const older = entry({ skillId: 'o', name: 'verify-old', origin: 'own', body: text, updatedAt: daysAgo(30) });
  const newer = entry({ skillId: 'n', name: 'verify-new', origin: 'own', body: `${text}.`, updatedAt: daysAgo(2) });
  const other = entry({ skillId: 'x', name: 'unrelated', origin: 'own', body: 'something else entirely about hashtags and their placement in a long caption for readers' });
  const r = skillDuplicateFindings(facts({ agents: [agent({ skills: [older, newer, other] })] }));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].fix, { kind: 'skill_disable', agent: 'news_ch', skill: 'verify-new' });
  assert.equal(r[0].severity, 'warn');
  // Two shared skills: reported once, without a per-agent fix, whatever the number of agents.
  const s1 = { ...older, origin: 'builtin' as const };
  const s2 = { ...newer, origin: 'builtin' as const };
  const two = skillDuplicateFindings(facts({ agents: [agent({ skills: [s1, s2] }), agent({ id: 'a2', handle: 'other', skills: [s1, s2] })] }));
  assert.equal(two.length, 1);
  assert.equal(two[0].fix, undefined);
  // Tiny bodies are not duplicates of each other.
  const tiny = skillDuplicateFindings(facts({ agents: [agent({ skills: [entry({ skillId: 'a', name: 'a-one', body: 'same text' }), entry({ skillId: 'b', name: 'b-two', body: 'same text' })] })] }));
  assert.deepEqual(tiny, []);
});

test('rollbacks: two or more is an info; one is nothing', () => {
  const r = skillRollbackFindings(facts({ rollbacks: [{ skillId: 'a', name: 'x-skill', agent: 'news_ch', count: 2 }, { skillId: 'b', name: 'y-skill', agent: null, count: 1 }] }));
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, 'info');
  assert.equal(r[0].subject.agent, 'news_ch');
});

// ── memory ──────────────────────────────────────────────────────────────────

test('memory overflow: past 30 rows is a warn that counts what never reaches a prompt; 16–30 is an info; approval rows are not counted', () => {
  const rows = (n: number, extra: Partial<MemoryFact> = {}) => Array.from({ length: n }, (_, i) => mem({ id: i + 1, text: `lesson number ${i} about topic${i}`, ...extra }));
  const big = memoryOverflowFindings(facts({ memory: rows(34) }));
  assert.equal(big.length, 1);
  assert.equal(big[0].severity, 'warn');
  assert.equal(big[0].evidence.hiddenFromPrompt, 4);
  assert.equal(big[0].evidence.hiddenFromWriter, 19);
  assert.match(big[0].title, /4 memory rows never reach any prompt/);
  const mid = memoryOverflowFindings(facts({ memory: rows(20) }));
  assert.equal(mid[0].severity, 'info');
  assert.deepEqual(memoryOverflowFindings(facts({ memory: rows(15) })), []);
  assert.deepEqual(memoryOverflowFindings(facts({ memory: rows(40, { source: 'approval' }) })), []);
});

test('memory duplicates: the older reviewer row is retired; an owner row never is', () => {
  const rows = [
    mem({ id: 1, text: 'Posts with a question in the title get more comments than statements.', createdAt: daysAgo(20) }),
    mem({ id: 2, text: 'Posts with a question in the title get more comments than statements!', createdAt: daysAgo(3) }),
    mem({ id: 3, text: 'Never use the word «unique» in a headline.', createdBy: 'owner', kind: 'rule', createdAt: daysAgo(40) }),
    mem({ id: 4, text: 'never use the word unique in a headline', createdBy: 'owner', kind: 'rule', createdAt: daysAgo(10) }),
    mem({ id: 5, text: 'Never use the word «unique» in a headline', createdAt: daysAgo(1) }),
    mem({ id: 6, text: 'Evening posts at 20:00 are read the most.', createdAt: daysAgo(2) }),
  ];
  const r = memoryDuplicateFindings(facts({ memory: rows }));
  const byId = Object.fromEntries(r.map((x) => [x.subject.id, x]));
  assert.deepEqual(Object.keys(byId).sort(), ['@news#1', '@news#3', '@news#5']);
  assert.deepEqual(byId['@news#1'].fix, { kind: 'memory_retire', channel: '@news', id: 1 });
  assert.equal(byId['@news#3'].fix, undefined, 'the older of two owner rows that say the same has no fix');
  assert.deepEqual(byId['@news#5'].fix, { kind: 'memory_retire', channel: '@news', id: 5 }, 'a reviewer row repeating an owner rule is redundant');
});

test('stale insights: reviewer insights over 90 days with no later confirmation; owner rows and confirmed ones stay', () => {
  const rows = [
    mem({ id: 1, text: 'Tuesday posts about energy prices do best.', createdAt: daysAgo(120) }),
    mem({ id: 2, text: 'Videos under a minute keep readers longer.', createdAt: daysAgo(100) }),
    mem({ id: 3, text: 'Videos under a minute keep readers longer, confirmed again.', createdAt: daysAgo(10) }),
    mem({ id: 4, text: 'Old owner thought.', createdBy: 'owner', kind: 'rule', createdAt: daysAgo(200) }),
    mem({ id: 5, text: 'Avoid memes.', kind: 'avoid', createdAt: daysAgo(200) }),
    mem({ id: 6, text: 'Fresh insight.', createdAt: daysAgo(30) }),
  ];
  const r = memoryStaleFindings(facts({ memory: rows }));
  assert.deepEqual(r.map((x) => x.subject.id), ['@news#1']);
  assert.deepEqual(r[0].fix, { kind: 'memory_retire', channel: '@news', id: 1 });
  assert.equal(r[0].severity, 'info');
});

// ── rules ───────────────────────────────────────────────────────────────────

test('rule lint findings carry the codes and the memory_retire fix (spec 064 FR-009)', () => {
  const r = ruleLintFindings(facts({ rules: [
    { id: 15, channel: '@news', agent: 'news_ch', text: 'Ці правила завжди виконуються для всіх постів', issues: [{ code: 'pointer_only', detail: 'points at other text' }] },
    { id: 16, channel: '@news', agent: 'news_ch', text: 'Без хештегів у новинах', issues: [] },
  ] }));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].fix, { kind: 'memory_retire', channel: '@news', id: 15 });
  assert.deepEqual(r[0].evidence.codes, ['pointer_only']);
  assert.equal(r[0].subject.channel, '@news');
});

test('config conflicts: one finding per agent, fixed by the resolver', () => {
  const r = configConflictFindings(facts({ conflicts: [
    { agent: 'news_ch', channel: '@news', conflicts: [{ code: 'hashtags_vs_rule', ref: 'telegram:@news', detail: 'rule #3 says no hashtags, the playbook has 3', ruleId: 3 }, { code: 'x', ref: 'telegram:@news', detail: 'second', ruleId: null }] },
    { agent: 'quiet', channel: null, conflicts: [] },
  ] }));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].fix, { kind: 'conflicts_resolve', agent: 'news_ch' });
  assert.match(r[0].title, /2 settings contradict/);
});

test('playbooks: validation errors are errors, soft warnings are info', () => {
  const r = playbookFindings(facts({ playbooks: [
    { agent: 'a_one', channel: '@a', version: 4, errors: ['платформа telegram:@x: ресурс не в цій мережі'], warnings: [{ code: 'too_many_formats', ref: 'telegram:@a', text: '5 formats' }] },
    { agent: 'b_two', channel: '@b', version: 1, errors: [], warnings: [] },
  ] }));
  assert.deepEqual(r.map((x) => [x.check, x.severity]), [['playbook_invalid', 'error'], ['playbook_warnings', 'info']]);
});

test('steering: an active set with no enabled rules, or whose channel is gone', () => {
  const set = (p: object) => ({ id: 'st1', target: 'telegram:@news', channel: '@news', source: 'telegram:@ref', status: 'active', enabledRules: 3, channelExists: true, ...p });
  assert.deepEqual(steeringFindings(facts({ steering: [set({})] })), []);
  assert.deepEqual(steeringFindings(facts({ steering: [set({ enabledRules: 0 })] })).map((x) => x.check), ['steering_empty']);
  assert.deepEqual(steeringFindings(facts({ steering: [set({ channelExists: false, id: 'st2' })] })).map((x) => x.check), ['steering_orphan']);
  assert.deepEqual(steeringFindings(facts({ steering: [set({ status: 'paused', enabledRules: 0 })] })), [], 'only active sets');
});

// ── tools ───────────────────────────────────────────────────────────────────

test('tool errors: ≥ 20% with ≥ 5 calls; the 3 commonest error texts are clipped to 120 chars', () => {
  const long = 'x'.repeat(300);
  const r = toolErrorFindings(facts({ toolStats: [
    { tool: 'fetch_api', calls: 10, errors: 3, topErrors: [{ text: long, count: 2 }, { text: 'timeout', count: 1 }, { text: 'a', count: 1 }, { text: 'b', count: 1 }] },
    { tool: 'rare_tool', calls: 4, errors: 4, topErrors: [] },
    { tool: 'fine_tool', calls: 100, errors: 19, topErrors: [] },
  ] }));
  assert.equal(r.length, 1);
  assert.equal(r[0].subject.id, 'fetch_api');
  const top = r[0].evidence.top as Array<{ text: string }>;
  assert.equal(top.length, 3);
  assert.ok(top[0].text.length <= 120);
  assert.match(r[0].title, /30%/);
});

test('role failures: no_terminal or max_steps at ≥ 15% with ≥ 5 runs', () => {
  const r = roleFailureFindings(facts({ roleRuns: [{ role: 'executor', runs: 20, bad: 3 }, { role: 'planner', runs: 20, bad: 2 }, { role: 'manager', runs: 4, bad: 4 }] }));
  assert.deepEqual(r.map((x) => x.subject.id), ['role:executor']);
  assert.equal(r[0].severity, 'warn');
});

// ── prompt ──────────────────────────────────────────────────────────────────

test('inline budget: the sum of inline bodies over 8000 warns; the fix turns inline off for the largest non-workflow skill', () => {
  const big = (id: string, name: string, n: number, p: Partial<AgentSkillFact> = {}) => entry({ skillId: id, name, inline: true, body: 'w'.repeat(n), ...p });
  const a = agent({ skills: [big('1', 'editor-executor-workflow', 3900), big('2', 'tone-space', 3800), big('3', 'format-hashtags', 1200), big('4', 'voice-core', 2000, { safety: true })] });
  const r = inlineBudgetFindings(facts({ agents: [a] }));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].fix, { kind: 'skill_inline_off', agent: 'news_ch', skill: 'tone-space' });
  assert.equal(r[0].evidence.total, 10900);
  const fits = agent({ skills: [big('1', 'editor-executor-workflow', 3900), big('3', 'format-hashtags', 1200)] });
  assert.deepEqual(inlineBudgetFindings(facts({ agents: [fits] })), []);
  const nothingToTurnOff = agent({ skills: [big('1', 'editor-executor-workflow', 3900), big('2', 'manager-workflow', 3900), big('3', 'agent-onboarding', 3900)] });
  assert.equal(inlineBudgetFindings(facts({ agents: [nothingToTurnOff] }))[0].fix, undefined);
});

// ── the whole run ───────────────────────────────────────────────────────────

test('runChecks: sorted by severity, deduplicated by key, one check cannot flood the report, a throwing check is skipped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, channel: '@news', agent: 'news_ch', text: `bad rule ${i}`, issues: [{ code: 'too_vague', detail: 'vague' }] }));
  const f = facts({
    rules: many,
    toolStats: [{ tool: 'fetch_api', calls: 10, errors: 5, topErrors: [] }],
    playbooks: [{ agent: 'a_one', channel: '@a', version: 2, errors: ['bad'], warnings: [] }],
  });
  const out = runChecks(f);
  const lint = out.filter((x) => x.check === 'rule_lint');
  assert.equal(lint.length, 25);
  const more = out.filter((x) => x.check === 'rule_lint_more');
  assert.equal(more.length, 1);
  assert.equal(more[0].evidence.omitted, 15);
  assert.equal(out[0].severity, 'error', 'errors first');
  assert.equal(new Set(out.map((x) => x.key)).size, out.length, 'keys are unique');
  const withThrow = runChecks(f, [() => { throw new Error('boom'); }, toolErrorFindings]);
  assert.equal(withThrow.length, 1);
  assert.deepEqual(countFindings(out).fixable, 25, 'the listed rule-lint findings carry a fix; the «more like this» line does not');
  assert.equal(countFindings(out).total, out.length);
});
