/**
 * Spec 034 T5 (FR-008) against a throwaway Postgres: the owner's examples from the chat card are stored in the
 * playbook — held until the first version exists, patched into a pending draft, a new active version otherwise —
 * and an agent's rebuild or an owner edit without `examples` keeps them. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { NetworkRepository } from './network.repository';
import { NetworkService } from './network.service';
import { PlaybookSchema, type PlaybookExample } from './playbook';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt034t5_sky';
const HANDLE = 'pgt034t5_nova';
let pool: Pool;
let agentId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Nova', $2, 'approve') RETURNING id`,
    [`telegram:${CH}`, HANDLE])).rows[0].id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'approve')`, [CH]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const REF = `telegram:${CH}`;
const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: REF, role: 'core', formats: { photo: 1, text: 0.6 }, per_day: { min: 1, max: 3 }, format_reasons: { photo: 'знімки неба', text: 'пояснення термінів' } }],
});
const ex = (text: string, verdict: 'good' | 'bad' = 'good'): PlaybookExample => ({ format: 'text', text, verdict, resource_ref: REF });

test('examples before the first playbook are held, then the first version takes them over', { skip }, async () => {
  const repo = new NetworkRepository(pool);
  const held = await repo.setExamples(agentId, [ex('Марс сьогодні за 62 мільйони кілометрів від Землі.'), ex('ВИ НЕ ПОВІРИТЕ, що знайшли на Марсі!', 'bad')], 'chat');
  assert.deepEqual(held, { target: 'held', version: null, count: 2 });
  assert.equal((await repo.playbookHistory(agentId)).length, 0, 'the holder is not a version');
  assert.equal(await repo.activePlaybook(agentId), null);

  // The build (an orchestrator's first version, no examples of its own) takes them over; the holder is gone.
  const v1 = await repo.insertPlaybook({ agentId, status: 'pending_owner', brief: 'Космос', body: BODY, rationale: 'first build', createdBy: 'orchestrator' });
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.body.examples.map((e) => e.verdict), ['good', 'bad']);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM playbooks WHERE agent_id = $1 AND status = 'draft'`, [agentId])).rows[0].count), 0);

  // A second card while the draft waits for the owner: patched in place, no new version.
  const pend = await repo.setExamples(agentId, [ex('Перигелій — точка орбіти, де планета найближче до Сонця.')], 'chat 2');
  assert.deepEqual(pend, { target: 'pending', version: 1, count: 3 });
  assert.equal((await repo.pendingPlaybook(agentId))!.body.examples[0].text, 'Перигелій — точка орбіти, де планета найближче до Сонця.');

  const active = await repo.decidePlaybook(v1.id, true);
  assert.equal(active!.status, 'active');
  assert.equal(active!.body.examples.length, 3);
});

test('an agent rebuild keeps the examples; the owner adds more as a new active version; a pending draft is kept', { skip }, async () => {
  const repo = new NetworkRepository(pool);
  const v2 = await repo.insertPlaybook({ agentId, status: 'active', brief: null, body: { ...BODY, platforms: [{ ...BODY.platforms[0], best_hours: [9] }] }, rationale: 'weights', createdBy: 'orchestrator' });
  assert.equal(v2.body.examples.length, 3, 'carried from the active version');
  const draft = await repo.insertPlaybook({ agentId, status: 'pending_owner', brief: null, body: { ...BODY, series: [] }, rationale: 'structural', createdBy: 'orchestrator' });
  assert.equal(draft.body.examples.length, 3);

  const r = await repo.setExamples(agentId, [ex('Сонячне затемнення 12 серпня буде видно з Іспанії.')], 'chat 3');
  assert.equal(r.target, 'active');
  const now = await repo.activePlaybook(agentId);
  assert.equal(now!.version, r.version);
  assert.equal(now!.createdBy, 'owner');
  assert.equal(now!.body.examples.length, 4);
  const stillPending = await repo.pendingPlaybook(agentId);
  assert.equal(stillPending!.id, draft.id, 'the agent draft is not superseded by examples');
  assert.equal(stillPending!.body.examples.length, 4, 'and it got the new example too');
});

test('an owner edit without `examples` keeps them; with `examples` it sets them', { skip }, async () => {
  const repo = new NetworkRepository(pool);
  const svc = new NetworkService({
    pool, agents: { getByHandle: async () => ({ id: agentId, handle: HANDLE, kind: 'orchestrator', scope: 'resource', scopeId: REF, mode: 'approve', parentId: null }), get: async () => null } as any,
    repo, inbox: { post: async () => 1 }, card: async () => ({ channelKey: CH, mode: 'approve', formats: { photo: 1, text: 1 }, sources: [] } as any),
    rebuild: async () => {},
  });
  const { examples: _drop, ...noExamples } = BODY;
  const kept = await svc.putPlaybook(HANDLE, { body: noExamples, rationale: 'owner edit' });
  assert.equal(kept.playbook.body.examples.length, 4);
  const cleared = await svc.putPlaybook(HANDLE, { body: { ...BODY, examples: [] }, rationale: 'owner clears' });
  assert.equal(cleared.playbook.body.examples.length, 0);
  await assert.rejects(svc.putPlaybook(HANDLE, { body: { ...BODY, examples: [ex('Варто зазначити, що у сучасному світі небо важливе.')] } }), (e: any) => e.response?.error === 'playbook_invalid' && /AI-штампи/.test(JSON.stringify(e.response.details)));
});
