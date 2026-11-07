/**
 * Spec 090 FR-010 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end): migration 103
 * up and down, the decision log, and undo dispatch (claim once, release on failure). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';
import { createProbeDb, MIGRATIONS_DIR, type ProbeDb } from '../agents/testing/probe-db';
import { AutonomyDecisionsRepository, AutonomyUndo, gateFamily } from './autonomy-decisions.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p090_decisions');
  pool = db.pool;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('migration 103: up, the down twice, then up again', { skip }, async () => {
  const up = readFileSync(join(MIGRATIONS_DIR, '103_autonomy_decisions.sql'), 'utf8');
  const down = readFileSync(join(MIGRATIONS_DIR, 'down', '103_autonomy_decisions.down.sql'), 'utf8');
  const exists = async () => ({
    table: (await pool.query(`SELECT to_regclass('public.autonomy_decisions') AS t`)).rows[0].t !== null,
    version: (await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '103_autonomy_decisions'`)).rowCount,
  });
  assert.deepEqual(await exists(), { table: true, version: 1 });
  await pool.query(down);
  await pool.query(down);
  assert.deepEqual(await exists(), { table: false, version: 0 });
  await pool.query(up);
  await pool.query(up);
  assert.deepEqual(await exists(), { table: true, version: 1 });
});

test('record, list, latestFor, counts', { skip }, async () => {
  const repo = new AutonomyDecisionsRepository(pool);
  const t = new Date('2026-11-07T10:00:00Z');
  const a = await repo.record({ gate: 'directive:frequency', refType: 'directive', refId: 'd1', channelKey: 'ch1', action: 'applied', summary: 'Frequency 3/day applied', at: t });
  const b = await repo.record({ gate: 'pending_action:repurpose', refType: 'pending_action', refId: 'p1', action: 'dropped', summary: 'Repurpose card expired', at: new Date(t.getTime() + 60_000) });
  assert.ok(a && b);
  const all = await repo.list({ since: t });
  assert.deepEqual(all.map((d) => d.refId).slice(0, 2), ['p1', 'd1']);
  assert.deepEqual((await repo.list({ channelKey: 'ch1' })).map((d) => d.refId), ['d1']);
  assert.equal((await repo.latestFor('directive', 'd1'))?.action, 'applied');
  const counts = await repo.counts(t, new Date(t.getTime() + 3_600_000));
  assert.deepEqual(counts, [{ family: 'directive', action: 'applied', n: 1 }, { family: 'pending_action', action: 'dropped', n: 1 }]);
  assert.equal(gateFamily('audit_fix:memory_retire'), 'audit_fix');
});

test('record never throws (a missing table is logged)', { skip }, async () => {
  const lines: string[] = [];
  const broken = new AutonomyDecisionsRepository({ query: async () => { throw new Error('relation does not exist'); } } as any, (m) => lines.push(m));
  assert.equal(await broken.record({ gate: 'playbook', refType: 'playbook', refId: 'x', action: 'applied', summary: 's' }), null);
  assert.match(lines[0], /not logged/);
});

test('undo: dispatch by kind, once, failure releases the claim, undone row written', { skip }, async () => {
  const repo = new AutonomyDecisionsRepository(pool);
  const undo = new AutonomyUndo(repo);
  const calls: string[] = [];
  let fail = true;
  undo.register('series_pause', async (u, ctx) => {
    calls.push(`${u.seriesKey}:${ctx.by}`);
    if (fail) throw new Error('boom');
  });
  assert.throws(() => undo.register('series_pause', async () => {}), /duplicate/);

  const id = (await repo.record({ gate: 'series_pause:no_material', refType: 'series_pause', refId: 'sp1', channelKey: 'ch2',
    action: 'resumed', summary: 'Series X resumed', undo: { kind: 'series_pause', channelKey: 'ch2', seriesKey: 'series:X' } }))!;
  const plain = (await repo.record({ gate: 'pending_action:*', refType: 'pending_action', refId: 'p2', action: 'dropped', summary: 'expired' }))!;
  const orphan = (await repo.record({ gate: 'playbook', refType: 'playbook', refId: 'v9', action: 'applied', summary: 'v9', undo: { kind: 'playbook_version' } }))!;

  assert.equal(undo.canUndo((await repo.get(id))!), true);
  assert.equal(undo.canUndo((await repo.get(plain))!), false);
  assert.equal(undo.canUndo((await repo.get(orphan))!), false, 'no handler registered');

  assert.deepEqual(await undo.undo(plain, 'owner'), { ok: false, error: 'no_undo' });
  assert.deepEqual(await undo.undo(orphan, 'owner'), { ok: false, error: 'no_handler' });
  assert.deepEqual(await undo.undo(999999, 'owner'), { ok: false, error: 'not_found' });

  const r1 = await undo.undo(id, 'owner');
  assert.equal(r1.ok, false);
  assert.equal((await repo.get(id))!.undoneAt, null, 'a failed undo releases the claim');

  fail = false;
  const r2 = await undo.undo(id, 'owner');
  assert.equal(r2.ok, true);
  assert.ok((await repo.get(id))!.undoneAt);
  assert.deepEqual(await undo.undo(id, 'owner'), { ok: false, error: 'already_undone' });
  assert.deepEqual(calls, ['series:X:owner', 'series:X:owner']);
  const latest = await repo.latestFor('series_pause', 'sp1');
  assert.equal(latest?.action, 'undone');
});
