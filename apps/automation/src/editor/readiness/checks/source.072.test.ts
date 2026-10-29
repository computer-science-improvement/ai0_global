import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryEntry } from '../../repo/editor-memory.repository';
import { ownerRulesOf } from '../../rules/owner-rules-prompt';
import type { SkillFact } from '../facts.types';
import { NANOBANANA_SKILL, PROMPTHERO_SKILL, type RealSkill } from '../fixtures/real-skills-1027';
import { makeFacts, mkPlaybook, mkSeries, mkSkill, promptSeries } from '../testing/facts-fixture';
import { sourceCheck } from './source';

/** Spec 072 FR-003.1, A8, A19, A29: series_source_contradicted, origin_original_with_source, skill_prescribes_source. */

const real = (s: RealSkill, over: Partial<SkillFact> = {}): SkillFact => mkSkill({ id: s.id, name: s.name, description: s.description, body: s.body, ...over });
const run = (init: Parameters<typeof makeFacts>[0]) => sourceCheck.run(makeFacts(init));
const ORIGIN_SKILL = mkSkill({ id: 'origin-synth', name: 'prompt-origin-synthetic', description: 'Як ставити origin', body: 'Для рядків library став origin=original.' });

test('the prompthero skill against a required series is an error with a switch-off fix and the skills link', () => {
  const out = run({ playbook: mkPlaybook([promptSeries()]), skills: [real(PROMPTHERO_SKILL)] });
  const x = out.find((f) => f.check === 'series_source_contradicted')!;
  assert.equal(x.severity, 'error');
  assert.equal(x.area, 'channel');
  assert.deepEqual(x.subject, { type: 'skill', id: `Prompt|skill:${PROMPTHERO_SKILL.id}`, label: `Prompt: ${PROMPTHERO_SKILL.name}`, agent: 'fx072', channel: '@fx072' });
  assert.deepEqual(x.fix, { kind: 'skill_disable', agent: 'fx072', skill: PROMPTHERO_SKILL.name });
  assert.equal(x.link, '/app/agents/fx072?tab=skills');
  assert.match(x.detail, /Series «Prompt» must take its material from library:prompts/);
  assert.match(x.detail, /provider=prompthero/);
  assert.equal((x.evidence as any).series, 'Prompt');
  assert.match(x.key, /^[0-9a-f]{16}$/);
});

test('the same contradiction against a suggested series is a warning', () => {
  const out = run({ playbook: mkPlaybook([promptSeries({ source_mode: 'suggested' })]), skills: [real(PROMPTHERO_SKILL)] });
  assert.equal(out.find((f) => f.check === 'series_source_contradicted')!.severity, 'warn');
});

test('two skills contradicting one series give two findings with different keys (A8)', () => {
  const out = run({ playbook: mkPlaybook([promptSeries()]), skills: [real(PROMPTHERO_SKILL), real(NANOBANANA_SKILL)] })
    .filter((f) => f.check === 'series_source_contradicted');
  assert.equal(out.length, 2);
  assert.notEqual(out[0].key, out[1].key);
  assert.deepEqual(out.map((f) => f.subject.id.split('|')[1].slice(0, 14)).sort(), [`skill:${NANOBANANA_SKILL.id.slice(0, 8)}`, `skill:${PROMPTHERO_SKILL.id.slice(0, 8)}`].sort());
});

test('one skill against two series gives two findings', () => {
  const out = run({ playbook: mkPlaybook([promptSeries(), promptSeries({ name: 'Prompt evening' })]), skills: [real(PROMPTHERO_SKILL)] })
    .filter((f) => f.check === 'series_source_contradicted');
  assert.deepEqual(out.map((f) => f.subject.id.split('|')[0]).sort(), ['Prompt', 'Prompt evening']);
});

test('an owner rule that names another source is a finding with the Memory link and no fix', () => {
  const out = run({ playbook: mkPlaybook([promptSeries()]), rules: [{ id: 42, text: 'Беру промпти для постів з https://prompthero.com, а не з бази.' }] });
  const x = out.find((f) => f.check === 'series_source_contradicted')!;
  assert.equal(x.subject.type, 'rule');
  assert.equal(x.subject.id, 'Prompt|rule:42');
  assert.equal(x.fix, undefined);
  assert.equal(x.link, '/app/agents/fx072?tab=memory');
});

test('a steering line that names another source is a finding of type steering', () => {
  const out = run({ playbook: mkPlaybook([promptSeries()]), steering: [{ id: 'set1/2', text: 'Беру промпти для постів з https://prompthero.com.' }] });
  const x = out.find((f) => f.check === 'series_source_contradicted')!;
  assert.equal(x.subject.type, 'steering');
  assert.equal(x.subject.id, 'Prompt|steering:set1/2');
  assert.equal(x.fix, undefined);
});

test('an approval-preference row that names another source is no candidate (A19)', () => {
  const entry = (id: number, text: string, evidence: unknown): MemoryEntry => ({ id, kind: 'rule', text, evidence, createdBy: 'owner', createdAt: new Date() } as MemoryEntry);
  const memory = [
    entry(1, 'Беру промпти для постів з https://prompthero.com, а не з бази.', { source: 'approval' }),
    entry(2, 'Не публікувати в неділю.', null),
  ];
  const rules = ownerRulesOf(memory);
  assert.deepEqual(rules.map((r) => r.id), [2]);
  const out = run({ playbook: mkPlaybook([promptSeries()]), rules });
  assert.deepEqual(out.filter((f) => f.check === 'series_source_contradicted'), []);
});

test('built-in and safety skills are never candidates', () => {
  const builtin = real(PROMPTHERO_SKILL, { scope: 'builtin' });
  const safety = real(NANOBANANA_SKILL, { safety: true });
  const out = run({ playbook: mkPlaybook([promptSeries()]), skills: [builtin, safety] });
  assert.deepEqual(out.filter((f) => f.check === 'series_source_contradicted' || f.check === 'skill_prescribes_source'), []);
});

test('a free series, and a channel without series, get no contradiction (A29)', () => {
  assert.deepEqual(run({ playbook: mkPlaybook([promptSeries({ source: { kind: 'free' } })]), skills: [real(PROMPTHERO_SKILL)] }).filter((f) => f.check === 'series_source_contradicted'), []);
  assert.deepEqual(run({ playbook: mkPlaybook([]), skills: [real(PROMPTHERO_SKILL)] }).filter((f) => f.check === 'series_source_contradicted'), []);
});

test('origin_original_with_source: an error when the channel has a library or feed series, else a warning, with a switch-off fix', () => {
  const lib = run({ playbook: mkPlaybook([promptSeries()]), skills: [ORIGIN_SKILL] }).find((f) => f.check === 'origin_original_with_source')!;
  assert.equal(lib.severity, 'error');
  assert.deepEqual(lib.subject, { type: 'skill', id: 'origin-synth', label: 'prompt-origin-synthetic', agent: 'fx072', channel: '@fx072' });
  assert.deepEqual(lib.fix, { kind: 'skill_disable', agent: 'fx072', skill: 'prompt-origin-synthetic' });
  assert.equal(lib.link, '/app/agents/fx072?tab=skills');
  assert.match(lib.detail, /origin=original/);
  const feed = run({ playbook: mkPlaybook([mkSeries({ source: { kind: 'feed', ref: 'feed1' } })]), skills: [ORIGIN_SKILL] }).find((f) => f.check === 'origin_original_with_source')!;
  assert.equal(feed.severity, 'error');
  const free = run({ playbook: mkPlaybook([mkSeries({ source: { kind: 'free' } })]), skills: [ORIGIN_SKILL] }).find((f) => f.check === 'origin_original_with_source')!;
  assert.equal(free.severity, 'warn');
  const api = run({ playbook: mkPlaybook([mkSeries({ source: { kind: 'api', source: 'nasa_apod' } })]), skills: [ORIGIN_SKILL] }).find((f) => f.check === 'origin_original_with_source')!;
  assert.equal(api.severity, 'warn', 'an api series alone is not library or feed');
});

test('the real nanobanana v4 text does not trip origin_original_with_source (A1)', () => {
  const out = run({ playbook: mkPlaybook([promptSeries()]), skills: [real(NANOBANANA_SKILL)] });
  assert.deepEqual(out.filter((f) => f.check === 'origin_original_with_source'), []);
});

test('skill_prescribes_source: a source hit that contradicts no series is a warning without a fix', () => {
  const out = run({ playbook: mkPlaybook([]), skills: [real(PROMPTHERO_SKILL)] });
  const x = out.find((f) => f.check === 'skill_prescribes_source')!;
  assert.equal(x.severity, 'warn');
  assert.equal(x.fix, undefined);
  assert.deepEqual(x.subject.id, PROMPTHERO_SKILL.id);
  assert.match(x.detail, /provider=prompthero/);
  // A skill that contradicts a series is reported once, as the contradiction.
  const both = run({ playbook: mkPlaybook([promptSeries()]), skills: [real(PROMPTHERO_SKILL)] });
  assert.equal(both.filter((f) => f.check === 'skill_prescribes_source').length, 0);
});

test('a hit with no token is skill_prescribes_source, never a contradiction', () => {
  const api = mkSkill({ id: 'api-skill', name: 'prompt-api', description: 'Промпти для каналу', body: 'Беру пости з API щодня.' });
  const out = run({ playbook: mkPlaybook([promptSeries()]), skills: [api] });
  assert.deepEqual(out.map((f) => f.check), ['skill_prescribes_source']);
});

test('without an agent there is no fix and the agent link is left out', () => {
  const f = makeFacts({ playbook: mkPlaybook([promptSeries()]), skills: [real(PROMPTHERO_SKILL)] });
  const out = sourceCheck.run({ ...f, agent: null });
  const x = out.find((y) => y.check === 'series_source_contradicted')!;
  assert.equal(x.fix, undefined);
  assert.equal(x.link, undefined);
  assert.equal(x.subject.agent, undefined);
});

test('a feed series is judged against the address the card source holds', () => {
  const series = mkSeries({ name: 'Новини дня', brief: 'Щоденні новини ШІ з фіду', source: { kind: 'feed', ref: 'feed1' } });
  const skill = mkSkill({ id: 'news-skill', name: 'ai-news-style', description: 'Новини ШІ для каналу', body: 'Беру новини з https://openai.com/blog щодня.' });
  const out = run({ card: { sources: [{ id: 'feed1', kind: 'rss', ref: 'https://www.marktechpost.com/feed/' }] }, playbook: mkPlaybook([series]), skills: [skill] });
  assert.equal(out.filter((f) => f.check === 'series_source_contradicted').length, 1);
  // The id of an unknown card source gives no token: nothing to judge.
  const none = run({ playbook: mkPlaybook([series]), skills: [skill] });
  assert.deepEqual(none.filter((f) => f.check === 'series_source_contradicted'), []);
});
