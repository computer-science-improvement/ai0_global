/**
 * Spec 025 T1 on a throwaway Postgres with every migration applied: 065 re-applied over a pre-065 shape
 * (no binding column, the narrow 053 CHECKs) backfills kind='advice' rows and widens the CHECKs; a second
 * application is a no-op; the repository filters by binding / kind / verified.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { DirectivesRepository } from './directives.repository';
import { ManagerService } from './manager.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const HANDLE = 'pgt025b_orch';
const MIGRATION = readFileSync(join(__dirname, '../../../../../database/migrations/065_directive_binding.sql'), 'utf8');
let pool: Pool;
let orchId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  orchId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', 'telegram:@pgt025b', 'B', $1, 'live') RETURNING id`, [HANDLE])).rows[0].id;
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const insertRaw = (kind: string, status = 'new') => pool.query(
  `INSERT INTO agent_directives (to_agent_id, kind, body, rationale, status) VALUES ($1, $2, 'body text', 'rationale text', $3) RETURNING id`,
  [orchId, kind, status]).then((r) => r.rows[0].id as string);

const constraintDef = async (name: string) => (await pool.query(
  `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'agent_directives'::regclass AND conname = $1`, [name])).rows[0]?.d ?? null;

test('065 over a pre-065 table: backfills advice rows, widens the CHECKs; a second run is a no-op', { skip }, async () => {
  // Put the table back into its 053 shape (the narrow inline CHECKs under other names, no binding column).
  await pool.query(`DELETE FROM agent_directives WHERE status IN ('contested','declined','failed') OR owner_decision IN ('upheld','refusal_accepted')`);
  await pool.query(`UPDATE playbooks SET directive_id = NULL WHERE directive_id IS NOT NULL`);
  await pool.query(`ALTER TABLE agent_directives DROP CONSTRAINT agent_directives_status_check`);
  await pool.query(`ALTER TABLE agent_directives DROP CONSTRAINT agent_directives_owner_decision_check`);
  await pool.query(`ALTER TABLE agent_directives DROP COLUMN binding`);
  await pool.query(`ALTER TABLE agent_directives ADD CONSTRAINT legacy_status_chk CHECK (status IN ('new','awaiting_owner','accepted','rejected','applied','evaluated','expired','canceled'))`);
  await pool.query(`ALTER TABLE agent_directives ADD CONSTRAINT legacy_owner_chk CHECK (owner_decision IN ('approved','declined','timeout_applied','timeout_dropped'))`);
  const advice = await insertRaw('advice', 'applied');
  const task = await insertRaw('task');
  await assert.rejects(insertRaw('task', 'contested'), /check constraint/);

  await pool.query(MIGRATION);
  const rows = (await pool.query(`SELECT id, binding FROM agent_directives WHERE id = ANY($1::uuid[])`, [[advice, task]])).rows;
  assert.equal(rows.find((r) => r.id === advice).binding, 'advice');
  assert.equal(rows.find((r) => r.id === task).binding, 'directive');
  assert.equal(await constraintDef('legacy_status_chk'), null, 'the old CHECK is gone whatever its name');
  assert.equal(await constraintDef('legacy_owner_chk'), null);
  for (const st of ['contested', 'declined', 'failed']) await insertRaw('task', st);
  await pool.query(`UPDATE agent_directives SET owner_decision = 'upheld' WHERE id = $1`, [task]);
  await pool.query(`UPDATE agent_directives SET owner_decision = 'refusal_accepted' WHERE id = $1`, [task]);
  await assert.rejects(pool.query(`UPDATE agent_directives SET binding = 'maybe' WHERE id = $1`, [task]), /check constraint/);
  await assert.rejects(insertRaw('task', 'bogus'), /check constraint/);

  // Second application: clean, nothing changes.
  const before = (await pool.query(`SELECT id, binding, status FROM agent_directives WHERE to_agent_id = $1 ORDER BY id`, [orchId])).rows;
  const defs = await constraintDef('agent_directives_status_check');
  await pool.query(MIGRATION);
  assert.deepEqual((await pool.query(`SELECT id, binding, status FROM agent_directives WHERE to_agent_id = $1 ORDER BY id`, [orchId])).rows, before);
  assert.equal(await constraintDef('agent_directives_status_check'), defs);
  // The other FR-001 objects exist.
  const cols = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_directives' AND column_name = ANY($1::text[])`,
    [['change', 'exec_attempts', 'exec_error', 'verification', 'verified_at', 'contested_at']])).rows.map((r) => r.column_name).sort();
  assert.deepEqual(cols, ['change', 'contested_at', 'exec_attempts', 'exec_error', 'verification', 'verified_at']);
  assert.match(await (async () => (await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'playbooks_created_by_check'`)).rows[0].d)(), /directive/);
  await pool.query(`INSERT INTO resource_pauses (resource_ref, reason, until) VALUES ('telegram:@pgt025b', 'test', now() + interval '1 day')`);
  await assert.rejects(pool.query(`INSERT INTO resource_pauses (resource_ref, reason, until) VALUES ('telegram:@pgt025b', 'test', now() + interval '1 day')`), /duplicate key/);
  await pool.query(`DELETE FROM resource_pauses WHERE resource_ref = 'telegram:@pgt025b'`);
});

test('repository and REST filters: binding, kind, verified', { skip }, async () => {
  const repo = new DirectivesRepository(pool);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id = $1`, [orchId]);
  const mk = (kind: any, binding: any) => repo.insert({
    fromAgentId: null, toAgentId: orchId, kind, binding, structural: false, body: 'b', params: {}, rationale: 'r', evidence: null, expected: null,
    reviewAt: null, status: 'new', shadow: false, outcomeDetail: { at_filing: { metric: 'posts', value: 3 } },
  });
  const a = await mk('advice', undefined);
  const f = await mk('format_shift', 'advice');
  const d = await mk('frequency', 'directive');
  assert.equal(a.binding, 'advice', 'kind advice defaults to advice');
  assert.equal(d.binding, 'directive');
  assert.deepEqual(d.outcomeDetail, { at_filing: { metric: 'posts', value: 3 } });
  await pool.query(`UPDATE agent_directives SET verified_at = now(), verification = '{"adherence":"followed"}' WHERE id = $1`, [d.id]);

  const ids = async (f2: Parameters<DirectivesRepository['list']>[0]) => (await repo.list({ toAgentId: orchId, ...f2 })).map((x) => x.id).sort();
  assert.deepEqual(await ids({ binding: 'advice' }), [a.id, f.id].sort());
  assert.deepEqual(await ids({ binding: 'directive' }), [d.id]);
  assert.deepEqual(await ids({ kinds: ['format_shift', 'frequency'] }), [f.id, d.id].sort());
  assert.deepEqual(await ids({ verified: true }), [d.id]);
  assert.deepEqual(await ids({ verified: false, binding: 'advice' }), [a.id, f.id].sort());
  assert.equal(await repo.countOpenBinding(orchId, false), 1);

  const svc = new ManagerService({
    repo, agents: { getByHandle: async (h: string) => (h === HANDLE ? { id: orchId } as any : null), list: async () => [{ id: orchId, handle: HANDLE }] as any },
    digest: {} as any, runner: {} as any,
  });
  const out = await svc.directives({ binding: 'advice', agent: HANDLE });
  assert.deepEqual(out.directives.map((x) => x.id).sort(), [a.id, f.id].sort());
  const row = (await svc.directives({ verified: 'true', agent: HANDLE })).directives[0] as any;
  assert.equal(row.binding, 'directive');
  assert.deepEqual(row.verification, { adherence: 'followed' });
  assert.ok(row.verifiedAt instanceof Date);
  for (const k of ['change', 'execError', 'contestedAt']) assert.ok(k in row, k);

  // Declined advice is the escalation basis.
  await pool.query(`UPDATE agent_directives SET status = 'declined', updated_at = now() WHERE id = $1`, [f.id]);
  assert.equal((await repo.lastDeclinedAdvice(orchId, 'format_shift', new Date(Date.now() - 86_400_000)))?.id, f.id);
  assert.equal(await repo.lastDeclinedAdvice(orchId, 'format_shift', new Date(Date.now() + 60_000)), null);
});
