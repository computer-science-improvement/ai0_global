/**
 * Spec 046 FR-003 on a throwaway Postgres with every migration applied: an accepted directive is replaceable
 * (appliedFor) and listed as in force for the planners; a directive patch also lands in the pending owner draft;
 * advice is verified by an orchestrator playbook change, else not followed after the give-up window.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { NetworkRepository } from '../network/network.repository';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import { DirectivesRepository } from './directives.repository';
import { commitmentsText } from './manager-runner';
import { adviceVerifier, ADVICE_VERIFY_GIVE_UP_MS } from './executors';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const REF = 'telegram:@pgt046_space';
const HANDLE = 'pgt046_orch';
let pool: Pool;
let orchId: string;

async function cleanup() {
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'T046', handle: HANDLE, mode: 'live', createdBy: 'owner' })).id;
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const BODY = (): Playbook => PlaybookSchema.parse({ platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1, photo: 0.5 }, per_day: { min: 1, max: 4 } }] });

const file = async (repo: DirectivesRepository, kind: 'advice' | 'format_shift', status: 'new' | 'accepted' | 'applied', body = `test ${kind}`) => {
  const d = await repo.insert({
    fromAgentId: null, toAgentId: orchId, kind, binding: 'advice', structural: false, body, params: {}, rationale: 'r', evidence: null, expected: null,
    reviewAt: new Date(Date.now() + 7 * 86_400_000), status: 'new', shadow: false,
  });
  if (status === 'new') return d;
  await repo.update(d.id, { status: 'accepted', resolution: 'додам у бриф правило про короткі підписи' }, ['new']);
  if (status === 'accepted') return (await repo.get(d.id))!;
  return (await repo.markApplied(d.id, { verification: { kind: 'self_reported' } }))!;
};

test('046: accepted is replaceable, not open; in force for the planners', { skip }, async () => {
  const repo = new DirectivesRepository(pool);
  const a = await file(repo, 'advice', 'accepted', 'Коротші підписи до фото');
  assert.equal(await repo.openFor(orchId, 'advice'), null, 'accepted no longer blocks as open');
  assert.equal((await repo.appliedFor(orchId, 'advice'))?.id, a.id);
  const text = commitmentsText(await repo.inForce(orchId));
  assert.match(text!, /Коротші підписи/);
  assert.match(text!, /план оркестратора: додам у бриф/);
  await repo.update(a.id, { status: 'superseded', resolution: 'x' }, ['accepted', 'applied']);
  assert.equal(commitmentsText(await repo.inForce(orchId)), null);
});

test('046: a directive patch lands in the pending owner draft too', { skip }, async () => {
  const net = new NetworkRepository(pool);
  const repo = new DirectivesRepository(pool);
  await net.insertPlaybook({ agentId: orchId, status: 'active', brief: 'b', body: BODY(), rationale: 'v1', createdBy: 'owner' });
  const draft = await net.insertPlaybook({ agentId: orchId, status: 'pending_owner', brief: 'b', body: { ...BODY(), notes: ['чернетка оркестратора'] } as any, rationale: 'v2', createdBy: 'orchestrator' });
  const dir = await file(repo, 'format_shift', 'accepted');
  const setPhoto = (b: Playbook): Playbook | null => (b.platforms[0].formats.photo === 0.9 ? null : { ...b, platforms: [{ ...b.platforms[0], formats: { ...b.platforms[0].formats, photo: 0.9 } }] });
  const r = await net.applyDirectivePatch(orchId, dir.id, setPhoto, 'more photos');
  assert.ok(!('error' in r));
  assert.equal((r as any).pendingRebased, draft.version);
  const pending = await net.pendingPlaybook(orchId);
  assert.equal(pending?.id, draft.id, 'the draft is kept');
  assert.equal(pending?.body.platforms[0].formats.photo, 0.9, 'and carries the directive change');
  assert.equal((await net.activePlaybook(orchId))?.body.platforms[0].formats.photo, 0.9);
});

test('046: advice is followed only when the orchestrator changed its playbook', { skip }, async () => {
  const repo = new DirectivesRepository(pool);
  const net = new NetworkRepository(pool);
  await pool.query(`DELETE FROM playbooks WHERE agent_id = $1`, [orchId]);
  const adv = await file(repo, 'advice', 'applied', 'Менше опитувань');
  let now = new Date();
  const v = adviceVerifier(pool, () => now);
  assert.deepEqual(await v.verify(adv), { pending: true });
  now = new Date(Date.now() + ADVICE_VERIFY_GIVE_UP_MS + 60_000);
  const late = await v.verify(adv);
  assert.equal((late as any).adherence, 'not_followed');
  now = new Date();
  await net.insertPlaybook({ agentId: orchId, status: 'active', brief: 'b', body: BODY(), rationale: 'менше опитувань', createdBy: 'orchestrator' });
  const ok = await v.verify(adv);
  assert.equal((ok as any).adherence, 'followed');
  assert.equal((ok as any).verified, true);
});
