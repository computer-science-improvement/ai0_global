/**
 * Spec 055 T1 against a throwaway Postgres: the facts loader reads skills, runs, load_skill steps, rollbacks, memory,
 * steering and tool errors from the real schema, and the checks find what was seeded. Creates its own database next to
 * EDITOR_PG_TEST_URL (init.sql + every migration). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsRepository } from '../agents/agents.repository';
import { SkillStore } from '../agents/skill-store';
import { lintOwnerRule } from '../agents/rule-lint';
import { AuditQueries } from './audit-queries';
import { runChecks } from './checks';
import { createMigratedDb, type FreshDb } from './testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let db: FreshDb;
let q: AuditQueries;
const ids: { orch?: string; exec?: string; skillUnused?: string; skillUsed?: string; skillRolled?: string } = {};

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 't055q');
  const pool = db.pool;
  const agents = new AgentsRepository(pool);
  const skills = new SkillStore(pool);
  const orch = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@news_t055', name: 'News', handle: 'news_t055', createdBy: 'owner' });
  const exec = await agents.insert({ kind: 'executor', scope: 'resource', scopeId: 'telegram:@news_t055', parentId: orch.id, name: 'Exec', handle: 'news_t055_exec', createdBy: 'sync' });
  ids.orch = orch.id;
  ids.exec = exec.id;
  const mk = async (name: string, body: string, applies = '{executor}') =>
    (await pool.query(`INSERT INTO skills (name, scope, description, applies_to, body, created_by) VALUES ($1, 'global', $2, $3, $4, 'owner') RETURNING id`,
      [name, `Description of ${name} skill`, applies, body])).rows[0].id as string;
  ids.skillUnused = await mk('format-unused', 'Use `publish_post` and `get_magic_numbers` when writing.');
  ids.skillUsed = await mk('format-used', 'A perfectly fine skill about polls and their options.');
  ids.skillRolled = await mk('format-rolled', 'Another fine skill about hashtags and where they go.');

  await pool.query(`INSERT INTO editor_channels (channel_key, title) VALUES ('@news_t055', 'News'), ('@other_t055', 'Other')`);
  const mem = (text: string, by: string, age: number, kind = 'insight', evidence: unknown = null) =>
    pool.query(`INSERT INTO editor_channel_memory (channel_key, kind, text, evidence, created_by, created_at) VALUES ('@news_t055', $1, $2, $3, $4, $5)`,
      [kind, text, evidence ? JSON.stringify(evidence) : null, by, daysAgo(age)]);
  await mem('Posts with a question in the title get more comments than statements.', 'reviewer', 20);
  await mem('Posts with a question in the title get more comments than statements!', 'reviewer', 3);
  await mem('Tuesday posts about energy prices do best on this channel.', 'reviewer', 120);
  await mem('Ці правила завжди виконуються для всіх постів', 'owner', 2, 'rule');
  await mem('Prefers short lead sentences', 'owner', 1, 'rule', { source: 'approval' });

  // 12 runs of the executor child; the unused skill is never loaded, the used one twice; one load failed.
  const run = async (status: string, role = 'executor', agentId = exec.id, startedAt = daysAgo(1)) =>
    (await pool.query(`INSERT INTO editor_runs (role, channel_key, model, status, agent_id, started_at) VALUES ($1, '@news_t055', 'm', $2, $3, $4) RETURNING id`, [role, status, agentId, startedAt])).rows[0].id as string;
  const step = (runId: string, idx: number, tool: string, input: unknown, output: unknown, isError: boolean, at = daysAgo(1)) =>
    pool.query(`INSERT INTO editor_run_steps (run_id, idx, type, tool_name, input, output, is_error, created_at) VALUES ($1, $2, 'tool', $3, $4, $5, $6, $7)`,
      [runId, idx, tool, JSON.stringify(input), JSON.stringify(output), isError, at]);
  let first = '';
  for (let i = 0; i < 12; i++) {
    const r = await run(i < 4 ? 'no_terminal' : 'ok');
    if (!first) first = r;
    if (i < 2) await step(r, 1, 'load_skill', { name: 'format-used' }, { name: 'format-used', body: 'x' }, false);
    if (i === 2) await step(r, 1, 'load_skill', { name: 'format-rolled' }, { error: 'unknown_skill' }, true);
  }
  // fetch_api: 6 calls, 3 errors (two of one text). An old step (10 days) must not count.
  for (let i = 0; i < 6; i++) await step(first, 10 + i, 'fetch_api', { url: 'u' }, i < 3 ? { error: i < 2 ? 'timeout while fetching' : 'http 500' } : { ok: true }, i < 3);
  await step(first, 30, 'fetch_api', { url: 'u' }, { error: 'ancient' }, true, daysAgo(10));

  // skill_versions: format-rolled rolled back twice, once long ago.
  const ver = (n: number, outcome: string, age: number) => pool.query(
    `INSERT INTO skill_versions (skill_id, version, body, description, applies_to, author, outcome, created_at) VALUES ($1, $2, 'b', 'd', '{executor}', 'agent', $3, $4)`,
    [ids.skillRolled, n, outcome, daysAgo(age)]);
  await ver(1, 'rolled_back', 5);
  await ver(2, 'rolled_back', 20);
  await ver(3, 'rolled_back', 90);
  await ver(4, 'kept', 1);

  // steering: an active set with no usable rules; one whose channel is gone; a paused one (ignored).
  const set = (target: string, key: string | null, status: string, rules: unknown) => pool.query(
    `INSERT INTO steering_sets (target_ref, channel_key, source_ref, status, rules) VALUES ($1, $2, 'telegram:@ref_t055', $3, $4)`, [target, key, status, JSON.stringify(rules)]);
  await set('telegram:@news_t055', '@news_t055', 'active', [{ id: 'r1', enabled: false }, { id: 'r2', enabled: true, conflict: { with: 'x' } }]);
  await set('telegram:@gone_t055', '@gone_t055', 'active', [{ id: 'r1', enabled: true }]);
  await set('telegram:@other_t055', '@other_t055', 'paused', []);

  q = new AuditQueries({
    pool, agents, skills, tools: () => new Set(['publish_post', 'load_skill', 'fetch_api']),
    ruleLint: (text) => lintOwnerRule(text),
    conflicts: async (a) => (a.id === orch.id ? [{ code: 'hashtags_off_playbook', ref: 'telegram:@news_t055', detail: 'rule vs playbook', rule_id: 7 }] : []),
    playbook: async (a) => (a.id === orch.id ? { version: 3, errors: ['bad series'], warnings: [{ code: 'too_many_formats', ref: 'telegram:@news_t055', en: 'five formats' }] } : null),
    now: () => NOW,
  });
});

after(async () => {
  if (db) await db.drop();
});

test('the loader reads the real schema: agents fold their children in, loads and runs come from the window', { skip }, async () => {
  const f = await q.load();
  const a = f.agents.find((x) => x.handle === 'news_t055')!;
  assert.ok(a, 'the orchestrator is a top-level agent');
  assert.equal(f.agents.filter((x) => x.handle.startsWith('news_t055_exec')).length, 0, 'children are not listed on their own');
  assert.equal(a.runs, 12, 'the executor child counts for its orchestrator');
  assert.deepEqual(a.roles, ['executor']);
  assert.equal(a.loads['format-used'], 2);
  assert.equal(a.loads['format-rolled'], undefined, 'a failed load_skill does not count');
  const entry = a.skills.find((s) => s.name === 'format-unused')!;
  assert.equal(entry.enabled, true);
  assert.equal(entry.inline, false);
  assert.ok(f.skills.some((s) => s.name === 'format-used' && s.scope === 'global'));
  assert.deepEqual(f.rollbacks.map((r) => [r.name, r.count]), [['format-rolled', 2]], 'the 90-day-old rollback is outside the window');
  assert.equal(f.memory.length, 5);
  assert.equal(f.memory.find((m) => m.source === 'approval')?.createdBy, 'owner');
  assert.deepEqual(f.rules.map((r) => [r.id > 0, r.issues.map((i) => i.code)]), [[true, ['pointer_only']]], 'approval preferences are not owner rules');
  assert.deepEqual(f.steering.map((s) => [s.channel, s.enabledRules, s.channelExists]).sort(), [['@gone_t055', 1, false], ['@news_t055', 0, true]]);
  const fetch = f.toolStats.find((t) => t.tool === 'fetch_api')!;
  assert.deepEqual([fetch.calls, fetch.errors], [6, 3]);
  assert.deepEqual(fetch.topErrors, [{ text: 'timeout while fetching', count: 2 }, { text: 'http 500', count: 1 }]);
  const exec = f.roleRuns.find((r) => r.role === 'executor')!;
  assert.deepEqual([exec.runs, exec.bad], [12, 4]);
});

test('the checks find what was seeded, with fixes where the spec has them', { skip }, async () => {
  const out = runChecks(await q.load());
  const by = (check: string) => out.filter((x) => x.check === check);
  assert.deepEqual(by('skill_unknown_tool').map((x) => x.subject.label), ['format-unused']);
  assert.deepEqual(by('skill_unknown_tool')[0].evidence.unknown, ['get_magic_numbers']);
  assert.deepEqual(by('skill_unused').map((x) => x.subject.label).sort(), ['format-rolled', 'format-unused']);
  assert.deepEqual(by('skill_unused').find((x) => x.subject.label === 'format-unused')!.fix, { kind: 'skill_disable', agent: 'news_t055', skill: 'format-unused' });
  assert.deepEqual(by('skill_rollbacks').map((x) => x.subject.label), ['format-rolled']);
  assert.equal(by('memory_duplicate').length, 1);
  assert.equal(by('memory_stale').length, 1);
  assert.equal(by('rule_lint').length, 1);
  assert.equal(by('config_conflicts')[0].fix?.kind, 'conflicts_resolve');
  assert.deepEqual(by('playbook_invalid').map((x) => x.severity), ['error']);
  assert.deepEqual(by('steering_empty').length + by('steering_orphan').length, 2);
  assert.deepEqual(by('tool_errors').map((x) => x.subject.id), ['fetch_api']);
  assert.deepEqual(by('role_unfinished').map((x) => x.subject.id), ['role:executor']);
  assert.equal(out[0].severity, 'error');
});

test('a source that fails leaves that part empty; the audit still loads', { skip }, async () => {
  const broken = new AuditQueries({
    pool: { query: async (sql: string, ...rest: unknown[]) => { if (/steering_sets/.test(sql)) throw new Error('boom'); return (db.pool.query as any)(sql, ...rest); } } as any,
    agents: new AgentsRepository(db.pool), skills: new SkillStore(db.pool), tools: () => new Set(), now: () => NOW,
    ruleLint: async () => [], conflicts: async () => [], playbook: async () => null,
  });
  const f = await broken.load();
  assert.deepEqual(f.steering, []);
  assert.ok(f.skills.length >= 3);
});
