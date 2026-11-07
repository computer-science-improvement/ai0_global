/**
 * Spec 090 FR-006 against a throwaway Postgres with every migration applied: a memory_retire finding of a done report is
 * applied after 24 h through the real memory repository (decision row + working undo); a source_drop finding is not. Skipped
 * unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AutonomyDecisionsRepository, AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { AuditRepository, type ReportFinding } from './audit-report';
import { AuditService } from './audit.service';
import { retireMemoryPort } from './audit-ports';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
const CH = '@p090b_audit';

before(async () => { if (url) db = await createProbeDb(url, 'p090b_audit'); });
after(async () => { await db?.drop(); });

test('memory_retire is applied after 24 h and undone; source_drop waits', { skip }, async () => {
  await db.pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'shadow')`, [CH]);
  const memory = new EditorMemoryRepository(db.pool as any);
  const { rows } = await db.pool.query(
    `INSERT INTO editor_channel_memory (channel_key, kind, text, created_by) VALUES ($1, 'insight', 'a stale line', 'reviewer') RETURNING id`, [CH]);
  const memId = Number(rows[0].id);
  const repo = new AuditRepository(db.pool);
  const started = new Date('2026-11-03T06:40:00Z');
  const row = await repo.start('2026-W45', 'schedule', started);
  const findings: ReportFinding[] = [
    { key: 'k1', area: 'memory', check: 'memory_stale', severity: 'warn', subject: { type: 'channel', id: CH, label: CH }, title: 'Stale line', detail: 'd', evidence: {}, status: 'open',
      fix: { kind: 'memory_retire', channel: CH, id: memId } },
    { key: 'k2', area: 'channel', check: 'source_dead', severity: 'warn', subject: { type: 'channel', id: CH, label: CH }, title: 'Dead source', detail: 'd', evidence: {}, status: 'open',
      fix: { kind: 'source_drop', channel: CH, sourceId: 'x' } },
  ];
  await repo.finish(row!.id, { findings, summary: null, llm: null, costUsd: 0 }, started);

  const decisions = new AutonomyDecisionsRepository(db.pool);
  const svc = new AuditService({
    repo, pass: async () => { throw new Error('unused'); }, now: () => new Date(started.getTime() + 25 * 3_600_000),
    fixes: {
      agentByHandle: async () => null, patchSkill: async () => undefined, applyConflicts: async () => ({ applied: [], remaining: [] }),
      retireMemory: retireMemoryPort(memory), reactivateMemory: (c, id) => memory.reactivate(c, id),
    },
  });
  const undo = new AutonomyUndo(decisions);
  svc.registerUndo(undo);
  const env = () => undefined;

  assert.deepEqual(await svc.silenceSweep({ env, decisions }), { applied: 1, failed: 0 });
  const after1 = (await repo.get(row!.id))!;
  assert.equal(after1.findings[0].status, 'applied');
  assert.equal(after1.findings[0].by, 'auto:silence');
  assert.equal(after1.findings[1].status, 'open', 'source_drop waits');
  assert.equal((await memory.listAll(CH)).find((m) => m.id === memId)!.active, false);

  const [d] = await decisions.list({ channelKey: CH });
  assert.equal(d.gate, 'audit_fix:memory_retire');
  assert.equal(d.undo?.kind, 'memory_retire');
  const r = await undo.undo(d.id, 'owner');
  assert.equal(r.ok, true);
  assert.equal((await memory.listAll(CH)).find((m) => m.id === memId)!.active, true);

  // A second sweep finds nothing open that is safe.
  assert.deepEqual(await svc.silenceSweep({ env, decisions }), { applied: 0, failed: 0 });
});
