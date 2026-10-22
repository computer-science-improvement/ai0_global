/**
 * Spec 054 T4 against a throwaway Postgres (its own database): the suggestions read from real runs and steps (the
 * harness's own `tool_not_allowed` text), apply writing 'recommend' rows and a skill toggle, the manager digest block
 * and the weekly inbox note once per ISO week. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Pool } from 'pg';
import { defineTool } from '../harness/tool';
import { ToolRegistry } from '../harness/tool-registry';
import { AgentsRepository } from '../agents/agents.repository';
import { SkillStore } from '../agents/skill-store';
import { OwnerInbox } from '../agents/owner-inbox';
import { KpiDigestService } from '../manager/kpi-digest.service';
import { LoadoutRepository } from './loadout.repository';
import { LoadoutUsage } from './loadout-usage';
import { LoadoutAdminService } from './loadout.admin.service';
import { LoadoutScan, postWeeklyLoadoutNote } from './loadout-notes';
import { createLoadoutDb, type LoadoutDb } from './testing/loadout-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;

const mk = (name: string, kind: any = 'read') =>
  defineTool({ name, description: `${name} does a thing`, input: z.object({}), kind, roles: ['executor'], execute: async () => ({ ok: true }) });
const CORE = ['load_skill', 'fetch_feed', 'fetch_api', 'web_fetch', 'library_catalog', 'query_data', 'check_similarity'];
const registry = new ToolRegistry([...CORE.map((n) => mk(n)), mk('get_top_posts'), mk('get_recent_posts'), mk('check_links'), mk('publish_post', 'terminal'), mk('skip_slot', 'terminal')]);

let db: LoadoutDb;
let pool: Pool;
let admin: LoadoutAdminService;
let execId: string;

before(async () => {
  if (!url) return;
  db = await createLoadoutDb(url, 'suggest');
  pool = db.pool;
  const agents = new AgentsRepository(pool);
  const orch = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@lo_sug', name: 'Orch', handle: 'lo_sug', createdBy: 'sync' });
  execId = (await agents.insert({ kind: 'executor', scope: 'resource', scopeId: 'telegram:@lo_sug', parentId: orch.id, name: 'Exec', handle: 'lo_sug_executor', createdBy: 'sync' })).id;
  const skills = new SkillStore(pool);
  await skills.syncBuiltins({ all: () => [{ name: 'format-poll-quiz', description: 'polls', appliesTo: ['executor'], body: 'How to write a poll.' }] } as any);

  const offered = [...CORE, 'get_top_posts', 'get_recent_posts', 'publish_post', 'skip_slot'];
  // A custom loadout without check_links: the runs below tried to call it anyway.
  await new LoadoutRepository(pool).setTools(execId, offered, 'owner');
  for (let i = 0; i < 12; i++) {
    const { rows } = await pool.query(
      `INSERT INTO editor_runs (role, channel_key, model, agent_id, tools_offered, status) VALUES ('executor', '@lo_sug', 'm', $1, $2, 'ok') RETURNING id`, [execId, offered]);
    const run = rows[0].id;
    await pool.query(
      `INSERT INTO editor_run_steps (run_id, idx, type, tool_name, input, output, is_error) VALUES ($1, 0, 'tool', 'fetch_feed', '{}', '{"ok":true}', false)`, [run]);
    if (i < 3) {
      // The harness's own refusal of a tool that was not offered.
      await pool.query(
        `INSERT INTO editor_run_steps (run_id, idx, type, tool_name, input, output, is_error) VALUES ($1, 1, 'tool', 'check_links', '{}', $2, true)`,
        [run, JSON.stringify({ error: 'tool_not_allowed', details: 'unknown or disallowed tool "check_links"' })]);
    }
  }
  admin = new LoadoutAdminService({
    agents, repo: new LoadoutRepository(pool), usage: new LoadoutUsage(pool), registry, skills,
    rules: async () => ({ ownerRules: 0, memory: 0, steeringSets: 0, playbookRules: 0, chars: 0 }),
  });
});
after(async () => { if (db) await db.drop(); });

test('suggestions from real runs: refused calls are missing, never-called tools unused, an unloaded skill unused', { skip }, async () => {
  const v = await admin.view('lo_sug_executor');
  assert.equal(v.runs30d, 12);
  assert.deepEqual(v.suggestions.map((s) => s.id), ['missing:check_links', 'unused:get_recent_posts', 'unused:get_top_posts', 'skills_unused:format-poll-quiz']);
  assert.deepEqual(v.suggestions[0].evidence, { denied: 3 });
  assert.equal(v.tools.find((t) => t.name === 'check_links')!.calls30d, 0, 'a refused call is not a use');
});

test('digest block and the weekly note read the same suggestions', { skip }, async () => {
  const scan = new LoadoutScan({ agents: new AgentsRepository(pool), admin, ttlMs: 0 });
  const digest = new KpiDigestService({ pool, catalog: { list: async () => [] }, globalCapUsd: 3, loadout: () => scan.digestLines() });
  const dg = await digest.build();
  assert.deepEqual(dg.loadout, ['@lo_sug_executor: add check_links · remove get_recent_posts, get_top_posts · skills off format-poll-quiz']);
  assert.deepEqual(JSON.parse(digest.render(dg)).loadout, dg.loadout);

  const inbox = new OwnerInbox(pool);
  const now = new Date('2026-10-19T09:30:00Z');
  assert.equal(await postWeeklyLoadoutNote({ scan, inbox }, now), true);
  assert.equal(await postWeeklyLoadoutNote({ scan, inbox }, new Date('2026-10-22T09:30:00Z')), false, 'once per ISO week');
  const { rows } = await pool.query(`SELECT kind, severity, title, ref_type, ref_id, agent_id::text AS agent_id FROM agent_inbox WHERE kind = 'loadout_suggestions'`);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { kind: 'loadout_suggestions', severity: 'info', title: 'Інструменти агентів: 4 пропозиції', ref_type: 'loadout', ref_id: '2026-W43', agent_id: execId });
});

test('apply writes the "recommend" rows, switches to custom and turns the skill off; the suggestions are gone', { skip }, async () => {
  const before = await admin.view('lo_sug_executor');
  assert.equal(before.mode, 'custom');
  const v = await admin.apply('lo_sug_executor', { add: ['check_links'], remove: ['get_recent_posts', 'get_top_posts'], disableSkills: ['format-poll-quiz'] });
  assert.equal(v.mode, 'custom');
  assert.deepEqual(v.suggestions, []);
  const { rows } = await pool.query(`SELECT tool_name, enabled, created_by FROM agent_tools WHERE agent_id = $1 ORDER BY tool_name`, [execId]);
  assert.equal(rows.find((r) => r.tool_name === 'check_links')!.created_by, 'recommend');
  assert.equal(rows.find((r) => r.tool_name === 'get_top_posts')!.enabled, false, 'a dropped tool stays as a disabled row');
  assert.deepEqual(rows.filter((r) => r.enabled).map((r) => r.tool_name), [...CORE, 'check_links', 'publish_post', 'skip_slot'].sort());
  const sk = await pool.query(`SELECT enabled FROM agent_skills WHERE agent_id = $1`, [execId]);
  assert.deepEqual(sk.rows, [{ enabled: false }]);
  assert.equal((await admin.view('lo_sug_executor')).skills.find((s) => s.name === 'format-poll-quiz')!.enabled, false);
});
