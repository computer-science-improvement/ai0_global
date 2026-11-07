/**
 * Spec 090 FR-004 against a throwaway Postgres with every migration applied: a pending_owner playbook version past
 * PLAYBOOK_PENDING_HOURS is activated with a decision row and an undo; a structural one is not; the undo re-activates the
 * previous version. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AutonomyDecisionsRepository, AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { NetworkRepository } from './network.repository';
import { NetworkService } from './network.service';
import { PlaybookSchema, type Playbook } from './playbook';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let agentId: string;
let repo: NetworkRepository;
let decisions: AutonomyDecisionsRepository;
const CH = '@p090b_pb';
const env = (k: string) => ({ PLAYBOOK_PENDING_HOURS: '48' } as Record<string, string>)[k];

const body = (o: Partial<Playbook> = {}): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: `telegram:${CH}`, role: 'core', formats: { photo: 1 }, per_day: { min: 1, max: 3 } },
  ],
  series: [],
  ...o,
});

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p090b_playbook');
  const a = await db.pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Editor', 'p090b_pb', 'shadow') RETURNING id`, [`telegram:${CH}`]);
  agentId = a.rows[0].id;
  repo = new NetworkRepository(db.pool);
  decisions = new AutonomyDecisionsRepository(db.pool);
});
after(async () => { await db?.drop(); });

function service() {
  return new NetworkService({
    pool: db.pool, repo, inbox: { post: async () => null } as any, card: async () => null, rebuild: async () => undefined,
    agents: { get: async () => ({ id: agentId, handle: 'p090b_pb', scope: 'resource', scopeId: `telegram:${CH}` }), getByHandle: async () => null } as any,
  });
}

async function aged(id: string, hours: number) {
  await db.pool.query(`UPDATE playbooks SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [id, hours]);
}

test('a non-structural pending version is activated after the timeout; structural and young ones are not; undo re-activates', { skip }, async () => {
  const v1 = await repo.insertPlaybook({ agentId, status: 'active', brief: null, body: body(), rationale: 'v1', createdBy: 'owner' });
  const tone = body(); tone.platforms[0].tone = 'Спокійніше';
  const quiet = await repo.insertPlaybook({ agentId, status: 'pending_owner', brief: null, body: tone, rationale: 'tone', createdBy: 'orchestrator' });
  const svc = service();

  // Younger than 48 h: untouched.
  await aged(quiet.id, 47);
  assert.equal(await svc.silenceSweep({ env, decisions }), 0);
  assert.equal((await repo.playbook(quiet.id))!.status, 'pending_owner');

  await aged(quiet.id, 49);
  assert.equal(await svc.silenceSweep({ env, decisions }), 1);
  const after1 = await repo.playbook(quiet.id);
  assert.equal(after1!.status, 'active');
  assert.ok(after1!.decidedAt, 'decided_at is set');
  assert.equal((await repo.playbook(v1.id))!.status, 'superseded');
  const rows = await decisions.list({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gate, 'playbook');
  assert.equal(rows[0].action, 'applied');
  assert.equal(rows[0].undo?.kind, 'playbook_version');
  assert.equal(rows[0].undo?.previousId, v1.id);

  // Undo re-activates the previous version.
  const undo = new AutonomyUndo(decisions);
  svc.registerUndo(undo);
  const r = await undo.undo(rows[0].id, 'owner');
  assert.equal(r.ok, true);
  assert.equal((await repo.playbook(v1.id))!.status, 'active');
  assert.equal((await repo.playbook(quiet.id))!.status, 'superseded');

  // A structural version (a platform section added) keeps waiting and writes nothing.
  const wide = body({ platforms: [...body().platforms, { resource_ref: 'instagram:ig1', role: 'discovery', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } }] });
  const structural = await repo.insertPlaybook({ agentId, status: 'pending_owner', brief: null, body: wide, rationale: 'new platform', createdBy: 'orchestrator' });
  await aged(structural.id, 200);
  const before = (await decisions.list({})).length;
  assert.equal(await svc.silenceSweep({ env, decisions }), 0);
  assert.equal((await repo.playbook(structural.id))!.status, 'pending_owner');
  assert.equal((await decisions.list({})).length, before, 'a structural version writes no decision');

  // PLAYBOOK_PENDING_HOURS=0 waits forever.
  await db.pool.query(`UPDATE playbooks SET status = 'superseded' WHERE id = $1`, [structural.id]);
  const old = await repo.insertPlaybook({ agentId, status: 'pending_owner', brief: null, body: tone, rationale: 'tone again', createdBy: 'orchestrator' });
  await aged(old.id, 500);
  assert.equal(await svc.silenceSweep({ env: (k) => (k === 'PLAYBOOK_PENDING_HOURS' ? '0' : undefined), decisions }), 0);
  assert.equal(await svc.silenceSweep({ env: (k) => (k === 'OWNER_SILENCE' ? 'wait' : undefined), decisions }), 0, 'OWNER_SILENCE=wait keeps today\'s behaviour');
  assert.equal((await repo.playbook(old.id))!.status, 'pending_owner');
});
