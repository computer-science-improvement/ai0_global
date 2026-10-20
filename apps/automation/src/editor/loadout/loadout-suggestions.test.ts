import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSkillEntry } from '../agents/skill-store';
import { emptyUsage, type AgentUsage } from './loadout-usage';
import {
  loadoutSuggestions, skillInPrompt, splitApply, UNUSED_MIN_OFFERED, type SuggestionInput,
} from './loadout-suggestions';

const tool = (name: string, kind: 'read' | 'act' | 'terminal' = 'read') => ({ name, kind });
const universe = [tool('fetch_feed'), tool('get_top_posts'), tool('get_recent_posts'), tool('lint_post'), tool('act_x', 'act'), tool('publish_post', 'terminal'), tool('sql_readonly')];

const skill = (name: string, over: Partial<AgentSkillEntry> = {}, safety = false): AgentSkillEntry => ({
  skill: { name, scope: 'builtin', appliesTo: ['executor'], body: 'x', safety } as any,
  origin: 'builtin', enabled: true, inline: false, baseChanged: false, pending: false, ...over,
});

function input(over: Partial<SuggestionInput> = {}, usage: Partial<AgentUsage> = {}): SuggestionInput {
  return {
    role: 'executor', mode: 'role', enabled: [], universe, core: new Set(['fetch_feed', 'publish_post']), hardOut: new Set(['sql_readonly']),
    usage: { ...emptyUsage(), runs: 20, ...usage }, peers: null, skills: [], ...over,
  };
}

test('unused: an optional enabled tool offered in 10+ runs and never called; core, terminal and called tools are not', () => {
  const offered = new Map([['get_top_posts', 12], ['get_recent_posts', 40], ['fetch_feed', 40], ['publish_post', 40], ['lint_post', UNUSED_MIN_OFFERED - 1], ['act_x', 15]]);
  const tools = new Map([['get_recent_posts', { calls: 3, errors: 0, lastUsedAt: new Date() }]]);
  const s = loadoutSuggestions(input({}, { offered, tools }));
  assert.deepEqual(s.map((x) => x.id), ['unused:act_x', 'unused:get_top_posts']);
  assert.deepEqual(s[1], {
    id: 'unused:get_top_posts', kind: 'unused', tool: 'get_top_posts', action: 'remove',
    reason: 'Offered in 12 runs in 30 days and never called', evidence: { offered: 12, calls: 0 },
  });
});

test('unused: a tool the custom loadout already dropped is not suggested again', () => {
  const offered = new Map([['get_top_posts', 30]]);
  const s = loadoutSuggestions(input({ mode: 'custom', enabled: ['fetch_feed'] }, { offered }));
  assert.deepEqual(s, []);
});

test('missing: refused calls to a tool that is not offered, 2 or more; add', () => {
  const denied = new Map([['get_top_posts', 2], ['get_recent_posts', 1], ['sql_readonly', 5], ['nope', 9]]);
  const s = loadoutSuggestions(input({ mode: 'custom', enabled: ['fetch_feed'] }, { denied }));
  assert.deepEqual(s.map((x) => [x.id, x.action]), [['missing:get_top_posts', 'add']], 'once is noise; hard-excluded and unknown tools are not offered');
  assert.deepEqual(s[0].evidence, { denied: 2 });
  assert.match(s[0].reason, /^Tried to call get_top_posts 2 times/);
});

test('missing: a tool that is already offered is not missing (mode role offers everything)', () => {
  assert.deepEqual(loadoutSuggestions(input({}, { denied: new Map([['get_top_posts', 4]]) })), []);
});

test('peer: peers call it in 30%+ of runs, this agent lacks it; needs enough peer runs; missing wins', () => {
  const peers = { runs: 40, rates: new Map([['get_top_posts', 0.45], ['get_recent_posts', 0.29], ['lint_post', 0.9], ['fetch_feed', 1]]) };
  const base = { mode: 'custom' as const, enabled: ['fetch_feed', 'lint_post'] };
  const s = loadoutSuggestions(input({ ...base, peers }));
  assert.deepEqual(s.map((x) => x.id), ['peer:get_top_posts']);
  assert.deepEqual(s[0].evidence, { peerRuns: 40, peerPct: 45 });
  assert.match(s[0].reason, /45%/);
  assert.deepEqual(loadoutSuggestions(input({ ...base, peers: { ...peers, runs: 4 } })), [], 'too few peer runs');
  const both = loadoutSuggestions(input({ ...base, peers }, { denied: new Map([['get_top_posts', 3]]) }));
  assert.deepEqual(both.map((x) => x.id), ['missing:get_top_posts']);
});

test('stale: a stored name that is not a tool of the role any more; only in a custom loadout', () => {
  const s = loadoutSuggestions(input({ mode: 'custom', enabled: ['fetch_feed', 'old_tool', 'a_gone_one'] }));
  assert.deepEqual(s.map((x) => [x.id, x.action]), [['stale:a_gone_one', 'remove'], ['stale:old_tool', 'remove']]);
  assert.deepEqual(loadoutSuggestions(input({ mode: 'role', enabled: ['old_tool'] })), []);
});

test('skills_unused: an enabled on-demand skill never loaded while the agent ran 10+ times', () => {
  const skills = [
    skill('format-poll-quiz'), skill('loaded-one'), skill('off-one', { enabled: false }), skill('inline-one', { inline: true }),
    skill('safe-one', {}, true), skill('anti-slop'), skill('editor-executor-workflow'), skill('tone-warm'), skill('voice-core'),
  ];
  const loads = new Map([['loaded-one', { loads: 2, lastLoadedAt: new Date() }]]);
  const s = loadoutSuggestions(input({ skills }, { loads }));
  assert.deepEqual(s.map((x) => [x.id, x.action, x.skill]), [['skills_unused:format-poll-quiz', 'disable', 'format-poll-quiz']]);
  assert.deepEqual(s[0].evidence, { runs: 20, loads: 0 });
  assert.deepEqual(loadoutSuggestions(input({ skills }, { runs: 9 })), [], 'too few runs to call a skill unused');
});

test('skillInPrompt: workflow, voice, tone and agent-* skills are in the prompt already', () => {
  assert.deepEqual(['editor-planner-workflow', 'manager-workflow', 'voice-core', 'tone-dry', 'agent-chat-etiquette', 'human-voice'].map((n) => skillInPrompt(n, 'planner')), Array(6).fill(true));
  assert.equal(skillInPrompt('format-poll-quiz', 'executor'), false);
});

test('order is stable: missing, peer, unused, stale, skills; names alphabetical inside a kind; a second call gives the same ids', () => {
  const peers = { runs: 20, rates: new Map([['get_recent_posts', 0.5]]) };
  const i = input(
    { mode: 'custom', enabled: ['fetch_feed', 'act_x', 'lint_post', 'old'], peers, skills: [skill('zz-skill'), skill('aa-skill')] },
    { denied: new Map([['get_top_posts', 2]]), offered: new Map([['act_x', 12], ['lint_post', 12]]) },
  );
  const ids = loadoutSuggestions(i).map((x) => x.id);
  assert.deepEqual(ids, ['missing:get_top_posts', 'peer:get_recent_posts', 'unused:act_x', 'unused:lint_post', 'stale:old', 'skills_unused:aa-skill', 'skills_unused:zz-skill']);
  assert.deepEqual(loadoutSuggestions(i).map((x) => x.id), ids);
});

test('every suggestion carries a one-line English reason (no Cyrillic, no newline)', () => {
  const s = loadoutSuggestions(input(
    { mode: 'custom', enabled: ['fetch_feed', 'act_x', 'old'], peers: { runs: 20, rates: new Map([['get_recent_posts', 0.5]]) }, skills: [skill('s1')] },
    { denied: new Map([['get_top_posts', 2]]), offered: new Map([['act_x', 12]]) },
  ));
  assert.equal(s.length, 5);
  for (const x of s) assert.ok(/^[\x20-\x7e]+$/.test(x.reason) && x.reason.length < 140, x.reason);
});

test('splitApply: tools to add and remove, skills to disable', () => {
  const s = loadoutSuggestions(input(
    { mode: 'custom', enabled: ['fetch_feed', 'act_x', 'old'], skills: [skill('s1')] },
    { denied: new Map([['get_top_posts', 2]]), offered: new Map([['act_x', 12]]) },
  ));
  assert.deepEqual(splitApply(s), { add: ['get_top_posts'], remove: ['act_x', 'old'], disableSkills: ['s1'] });
});
