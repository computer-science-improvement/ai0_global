/**
 * Spec 048 FR-001 against a throwaway Postgres: the artifact registry over setup proposals, steering sets, owner rules,
 * memory, skills and playbooks; versions recorded on read and on edit; edits refused by the type's validation.
 * Skipped unless EDITOR_PG_TEST_URL is set. Everything runs in a rolled-back transaction.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { ChannelSetupRepository } from '../setup/setup.repository';
import { SteeringRepository } from '../steering/steering.repository';
import { SteeringService } from '../steering/steering.service';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { SkillStore } from '../agents/skill-store';
import { NetworkRepository } from '../network/network.repository';
import { lintOwnerRule } from '../agents/rule-lint';
import { ArtifactVersionsRepository } from './artifact-versions.repository';
import { memoryAdapter, playbookAdapter, rulesAdapter, setupAdapter, skillAdapter, steeringAdapter } from './artifact-adapters';
import { ArtifactsService } from './artifacts.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgtest_art_048';
const HANDLE = 'pgtest_art_048';
let pool: Pool;

before(async () => { if (url) pool = new Pool({ connectionString: url }); });
after(async () => { await pool?.end(); });

async function inTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}

const RULES = [1, 2, 3].map((i) => ({
  id: `s${i}`, kind: 'hook', text: `Відкривай пост коротким питанням до читача номер ${i}`, evidence: { post_ids: ['r1'], note: 'n' }, conflict: null, enabled: true,
}));

function service(c: PoolClient) {
  const versions = new ArtifactVersionsRepository(c);
  const steeringRepo = new SteeringRepository(c as any);
  const steering = new SteeringService({ repo: steeringRepo } as any);
  const memory = new EditorMemoryRepository(c as any);
  const net = new NetworkRepository(c as any);
  return new ArtifactsService({
    pool: c,
    adapters: [
      setupAdapter({ setup: new ChannelSetupRepository(c as any), versions }),
      steeringAdapter({ repo: steeringRepo, editRules: (id, b) => steering.editRules(id, b), versions }),
      rulesAdapter({ pool: c, memory, versions, lint: (t) => lintOwnerRule(t) }),
      memoryAdapter({ pool: c, memory }),
      skillAdapter({ pool: c, skills: new SkillStore(c as any) }),
      playbookAdapter({ pool: c, history: (id) => net.playbookHistory(id), put: async () => { throw new Error('not in this test'); } }),
    ],
  });
}

test('the registry lists every type for an agent, records versions and refuses what the type refuses', { skip }, async () => {
  await inTx(async (c) => {
    await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'shadow')`, [CH]);
    const agent = (await c.query(
      `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Editor', $2, 'shadow') RETURNING id`,
      [`telegram:${CH}`, HANDLE])).rows[0].id as string;
    const set = (await c.query(
      `INSERT INTO steering_sets (target_ref, channel_key, source_ref, source_title, status, rules, created_by)
       VALUES ($1, $2, 'telegram:@pgtest_ref_048', 'Reference', 'ready', $3, 'owner') RETURNING id`,
      [`telegram:${CH}`, CH, JSON.stringify(RULES)])).rows[0].id as string;
    const setup = (await c.query(
      `INSERT INTO channel_setup_proposals (channel_key, resource_ref, status, created_by) VALUES ($1, $2, 'analyzing', 'owner') RETURNING id`,
      [CH, `telegram:${CH}`])).rows[0].id as string;
    const memory = new EditorMemoryRepository(c as any);
    const rule1 = await memory.add(CH, 'rule', 'Пиши без емодзі у заголовку посту', { source: 'owner' }, 'owner');
    await memory.add(CH, 'insight', 'Опитування збирають більше реакцій', null, 'reviewer');
    await memory.add(CH, 'rule', 'Коротші абзаци', { source: 'approval' }, 'owner');
    const skill = (await c.query(
      `INSERT INTO skills (name, scope, agent_id, description, applies_to, body, created_by) VALUES ('pgtest-art-048', 'agent', $1, 'Тон каналу', '{executor}', 'Пиши просто.', 'owner') RETURNING id`,
      [agent])).rows[0].id as string;
    await c.query(`INSERT INTO skill_versions (skill_id, version, body, description, applies_to, author) VALUES ($1, 1, 'Пиши просто.', 'Тон каналу', '{executor}', 'owner')`, [skill]);
    await c.query(`INSERT INTO playbooks (agent_id, version, status, body, created_by) VALUES ($1, 1, 'active', '{}', 'owner')`, [agent]);

    const svc = service(c);
    const { rows } = await svc.list({ agent: HANDLE });
    const types = rows.map((r) => r.type).sort();
    assert.deepEqual(types, ['memory', 'playbook', 'rules', 'setup', 'skill', 'steering']);
    assert.equal(rows.find((r) => r.type === 'rules')!.summary, '1 rule', 'an approval preference is memory, not an owner rule');
    assert.equal(rows.find((r) => r.type === 'memory')!.summary, '2 lines learnt from reviews and approvals');
    assert.ok(rows.every((r) => r.agent === HANDLE));
    assert.deepEqual((await svc.list({ type: 'steering', agent: HANDLE, status: 'active' })).rows, []);

    // A read records version 1; a second read of the same body does not add one.
    const st = await svc.get('steering', set);
    assert.equal(st.row.version, 1);
    assert.deepEqual(st.actions.map((a) => a.key), ['edit', 'activate', 'discard']);
    assert.equal((await svc.get('steering', set)).versions.length, 1);
    assert.equal((await svc.get('setup', setup)).row.status, 'analyzing');

    // The owner's edit: a new rule, one disabled; version 2 by the owner.
    const edited = await svc.patch('steering', set, { patch: { rules: [{ id: 's2', enabled: false }], add: [{ kind: 'cta', text: 'Закінчуй пост одним питанням до читачів каналу' }] }, reason: 'tighter' });
    assert.equal(edited.row.version, 2);
    assert.equal((edited.body as any).rules.length, 4);
    assert.equal((edited.body as any).rules[3].id, 's4');
    assert.deepEqual(edited.versions.map((v) => [v.version, v.author, v.reason]), [[2, 'owner', 'tighter'], [1, 'system', null]]);
    assert.equal(((await svc.version('steering', set, 1)).body as any).rules.length, 3);
    await assert.rejects(svc.patch('steering', set, { patch: { remove: ['s9'] } }), /rule_not_found|Bad|Not/);

    // Rules: lint refuses a meta request; an edit replaces the line and records a version.
    const bad = await svc.edit('rules', CH, { add: ['зроби'] }, { author: 'agent', reason: 'asked' });
    assert.equal(bad.ok, false);
    const ok = await svc.edit('rules', CH, { edit: [{ id: rule1, text: 'Пиши заголовки без емодзі і без капсу' }], add: ['Кожен пост закінчуй питанням до читачів'] }, { author: 'agent', reason: 'owner asked in chat' });
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.deepEqual((ok.detail.body as any).rules.map((r: any) => r.text).sort(), ['Кожен пост закінчуй питанням до читачів', 'Пиши заголовки без емодзі і без капсу']);
      assert.equal(ok.detail.row.version, 2);
    }

    // Skills keep their own versions; a body that fails the skill lint is refused.
    const sk = await svc.get('skill', skill);
    assert.equal(sk.row.version, 1);
    assert.equal((await svc.edit('skill', skill, { body: '' }, { author: 'owner' })).ok, false);

    // Memory is read only except retiring a line; playbooks list one row per agent.
    assert.equal((await svc.get('playbook', agent)).row.status, 'active');
    assert.equal((await svc.edit('memory', CH, { retire: [999999] }, { author: 'owner' })).ok, false);
  });
});
