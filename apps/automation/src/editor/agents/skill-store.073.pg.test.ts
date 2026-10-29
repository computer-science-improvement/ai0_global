/**
 * Spec 073 FR-012 / A48 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end): the checks
 * the chat tools always ran now run in `SkillStore.writeAgentSkill`, for every caller. An agent's write is refused with the
 * existing error shapes (and stores nothing); the owner's is saved and says what it found in `warnings`. The series check runs
 * only with the `seriesSources` port. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from './testing/probe-db';
import { AgentsRepository } from './agents.repository';
import { SkillStore } from './skill-store';
import { requiredSeriesSources } from './series-sources';
import { buildAgentSkillTools } from './agent-skill-tools';
import { originRefusal } from './skill-warnings';
import { NetworkRepository } from '../network/network.repository';
import type { Agent } from './agent.types';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@p073skills';
let db: ProbeDb;
let pool: Pool;
let orch: Agent;
let executor: Agent;
let store: SkillStore;

/** The old Prompt skill: nothing the chat-tool checks see, wrong only against the series. */
const OLD_PROMPT_SKILL = '# Промпти\nДля кожного промпта став origin=original, джерело PromptHero.';
const BAD_ORIGIN = '# Промпти\nБери промпт з бібліотеки датасету і публікуй його з origin=original, вказуючи автора.';
const CLEAN = '# Стиль\nПиши коротко. Підпис — одне речення, без зайвих слів.';
const META = { description: 'How the channel labels its prompts', appliesTo: ['executor', 'composer'] };

const skillRows = async (name: string) => (await pool.query(`SELECT id FROM skills WHERE name = $1 AND scope = 'agent'`, [name])).rows;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p073_skill_store');
  pool = db.pool;
  const agents = new AgentsRepository(pool);
  orch = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, name: 'P073S', handle: 'p073_skills_orch', mode: 'live', createdBy: 'owner' });
  executor = await agents.insert({ kind: 'executor', scope: 'resource', scopeId: `telegram:${CH}`, parentId: orch.id, name: 'P073S writer', handle: 'p073_skills_writer', mode: 'live', createdBy: 'owner' });
  const body = {
    platforms: [{ resource_ref: `telegram:${CH}`, role: 'core', formats: { text: 1, photo: 1 }, per_day: { min: 1, max: 3 } }],
    series: [{
      name: 'Prompt', cadence: 'daily@17:00', resource_ref: `telegram:${CH}`, format: 'photo', brief: 'Промпт для генерації зображень',
      source: { kind: 'library', table: 'nanobanana_prompts' }, source_mode: 'required',
    }],
    rules: [],
  };
  await pool.query(`INSERT INTO playbooks (agent_id, version, status, body, created_by) VALUES ($1, 1, 'active', $2, 'orchestrator')`, [orch.id, JSON.stringify(body)]);
  store = new SkillStore(pool, { seriesSources: requiredSeriesSources({ agents, network: new NetworkRepository(pool) }) });
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('an agent writing the old Prompt skill is refused with the series error, and nothing is stored', { skip }, async () => {
  const r = await store.writeAgentSkill({ agentId: orch.id, name: 'prompt-origin', ...META, body: OLD_PROMPT_SKILL, author: 'agent', authorAgentId: executor.id });
  assert.ok('error' in r);
  assert.equal(r.error, 'series_source_conflict');
  assert.match(String(r.details), /origin=original/);
  assert.match(String(r.details), /library:nanobanana_prompts/);
  assert.equal(typeof r.hint, 'string');
  assert.deepEqual(await skillRows('prompt-origin'), []);
});

test('the same body from the owner is saved, with the warning in `warnings` and in `lint.warnings`', { skip }, async () => {
  const r = await store.writeAgentSkill({ agentId: orch.id, name: 'prompt-origin', ...META, body: OLD_PROMPT_SKILL, author: 'owner' });
  assert.ok('ok' in r, JSON.stringify(r));
  assert.equal(r.version, 1);
  assert.deepEqual(r.warnings?.map((w) => w.code), ['series_source_conflict']);
  assert.match(r.warnings![0].message, /^The skill contradicts a series: /);
  assert.ok(r.lint.warnings.some((w) => w.code === 'series_source_conflict'), 'the skills tab shows lint.warnings');
  assert.equal((await skillRows('prompt-origin')).length, 1);
});

test('a child agent is judged on its orchestrator\'s series; the chat-tool refusals now hold for every caller', { skip }, async () => {
  const series = await store.writeAgentSkill({ agentId: executor.id, name: 'child-prompt', ...META, body: OLD_PROMPT_SKILL, author: 'agent', authorAgentId: executor.id });
  assert.ok('error' in series);
  assert.equal(series.error, 'series_source_conflict');
  const origin = await store.writeAgentSkill({ agentId: executor.id, name: 'child-origin', ...META, body: BAD_ORIGIN, author: 'agent', authorAgentId: executor.id });
  assert.ok('error' in origin);
  assert.equal(origin.error, 'origin_original_with_source');
  assert.deepEqual({ error: origin.error, details: origin.details, hint: origin.hint }, originRefusal(BAD_ORIGIN));
  const source = await store.writeAgentSkill({ agentId: orch.id, name: 'child-source', ...META, body: 'Бери промпти з https://prompthero.com/ щодня.', author: 'agent' });
  assert.ok('error' in source);
  assert.equal(source.error, 'source_belongs_in_import');
  for (const n of ['child-prompt', 'child-origin', 'child-source']) assert.deepEqual(await skillRows(n), []);
});

test('the owner is warned about the chat-tool problems too, and still saves', { skip }, async () => {
  const r = await store.writeAgentSkill({ agentId: orch.id, name: 'owner-origin', ...META, body: BAD_ORIGIN, author: 'owner' });
  assert.ok('ok' in r, JSON.stringify(r));
  assert.deepEqual(r.warnings?.map((w) => w.code), ['origin_original_with_source']);
  assert.match(r.warnings![0].message, /origin_mismatch/);
});

test('a clean skill from the agent is written, goes through as before, and carries no `warnings` key', { skip }, async () => {
  const r = await store.writeAgentSkill({ agentId: orch.id, name: 'clean-style', ...META, body: CLEAN, author: 'agent', authorAgentId: executor.id });
  assert.ok('ok' in r, JSON.stringify(r));
  assert.equal('warnings' in r, false);
  assert.equal(r.lint.warnings.length, 0);
});

test('without the port the series check is not run; the other two are, and a failing port is as no port', { skip }, async () => {
  const plain = new SkillStore(pool);
  const ok = await plain.writeAgentSkill({ agentId: orch.id, name: 'plain-prompt', ...META, body: OLD_PROMPT_SKILL, author: 'agent' });
  assert.ok('ok' in ok, 'no series port: nothing to compare with');
  assert.equal('warnings' in ok, false);
  const bad = await plain.writeAgentSkill({ agentId: orch.id, name: 'plain-origin', ...META, body: BAD_ORIGIN, author: 'agent' });
  assert.ok('error' in bad);
  assert.equal(bad.error, 'origin_original_with_source');
  const failing = new SkillStore(pool, { seriesSources: async () => { throw new Error('db gone'); } });
  const f = await failing.writeAgentSkill({ agentId: orch.id, name: 'failing-prompt', ...META, body: OLD_PROMPT_SKILL, author: 'agent' });
  assert.ok('ok' in f, 'a port that throws must not stop a write');
});

test('the agent\'s own self-edit tool is refused for the old Prompt skill and still writes a clean one', { skip }, async () => {
  const [tool] = buildAgentSkillTools({
    agents: new AgentsRepository(pool), skills: store,
    kpi: { primary: async () => null }, inbox: { post: async () => ({}) as never },
  });
  const ctx = { runId: 'r', role: 'orchestrator' as const, channelKey: CH, extras: { agent: orch } };
  const bad: any = await tool.execute({
    skill: 'self-prompt-origin', description: 'How the channel labels its prompts', applies_to: ['executor'],
    body: OLD_PROMPT_SKILL, reason: 'так було написано в старому скілі, переношу його текст сюди',
  }, ctx);
  assert.equal(bad.error, 'series_source_conflict', JSON.stringify(bad));
  assert.deepEqual(await skillRows('self-prompt-origin'), []);
  const good: any = await tool.execute({
    skill: 'self-prompt-origin', description: 'How the channel labels its prompts', applies_to: ['executor'],
    body: CLEAN, reason: 'коротші підписи дають більше переглядів за останні 28 днів',
  }, ctx);
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal((await skillRows('self-prompt-origin')).length, 1, 'a refused write did not use up the day\'s one self-edit');
});

test('the agent guards still come first: a locked skill is skill_locked, not a content refusal', { skip }, async () => {
  const w = await store.writeAgentSkill({ agentId: orch.id, name: 'locked-one', ...META, body: CLEAN, author: 'owner' });
  assert.ok('ok' in w);
  await store.setLocked(w.skill.id, true);
  const r = await store.writeAgentSkill({ agentId: orch.id, name: 'locked-one', ...META, body: OLD_PROMPT_SKILL, author: 'agent' });
  assert.ok('error' in r);
  assert.equal(r.error, 'skill_locked');
});
