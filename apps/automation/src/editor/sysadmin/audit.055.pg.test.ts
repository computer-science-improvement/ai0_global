/**
 * Spec 055 T3 against a throwaway Postgres (init.sql + every migration): the migration (idempotent, @sysadmin allowed),
 * the weekly claim, the report and its findings, apply and dismiss, and the artifact adapter. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { AuditRepository, STALE_RUN_MS } from './audit-report';
import { AuditService, type AuditFixPorts } from './audit.service';
import { auditAdapter } from './audit-artifact';
import type { AuditPass } from './auditor-runner';
import { emptyFacts, type Finding } from './audit.types';
import { createMigratedDb, type FreshDb } from './testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const NOW = new Date('2026-10-21T09:00:00Z'); // Wednesday, ISO week 2026-W43

let db: FreshDb;
let clock = NOW;

const finding = (key: string, p: Partial<Finding> = {}): Finding => ({
  key, area: 'skills', check: 'skill_unused', severity: 'info', subject: { type: 'skill', id: `id-${key}`, label: `skill-${key}`, agent: 'news' },
  title: `Finding ${key}`, detail: 'd', evidence: {}, fix: { kind: 'skill_disable', agent: 'news', skill: `skill-${key}` }, ...p,
});
const pass = (findings: Finding[], comments: Record<string, string> = {}): AuditPass => ({
  facts: emptyFacts(NOW), findings, comments, summary: 'Summary', llm: { status: 'ok', note: '', runId: null, costUsd: 0.01 },
});

function setup(findings: Finding[], fixes: Partial<AuditFixPorts> = {}) {
  const calls: any[] = [];
  const ports: AuditFixPorts = {
    agentByHandle: async (h) => ({ id: 'a', handle: h } as any),
    patchSkill: async (h, n, p) => { calls.push(['patchSkill', h, n, p]); },
    retireMemory: async (c, i) => { calls.push(['retire', c, i]); return true; },
    applyConflicts: async () => ({ applied: ['x'], remaining: [] }),
    ...fixes,
  };
  const repo = new AuditRepository(db.pool);
  const svc = new AuditService({ repo, pass: async () => pass(findings, { [findings[0]?.key ?? 'x']: 'Comment' }), fixes: ports, now: () => clock });
  return { svc, repo, calls };
}

before(async () => { if (url) db = await createMigratedDb(url, 't055r'); });
after(async () => { if (db) await db.drop(); });

test('088: idempotent, and the agents table accepts the auditor kind; the registry sync creates @sysadmin once', { skip }, async () => {
  const sql = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '088_audit_reports.sql'), 'utf8');
  await db.pool.query(sql);
  await db.pool.query(sql);
  const agents = new AgentsRepository(db.pool);
  const sync = new AgentRegistrySync({ agents, channels: { list: async () => [] } as any });
  await sync.run();
  await sync.run();
  const { rows } = await db.pool.query(`SELECT handle, kind, scope, mode FROM agents WHERE kind = 'auditor'`);
  assert.deepEqual(rows, [{ handle: 'sysadmin', kind: 'auditor', scope: 'system', mode: 'live' }]);
});

test('the weekly claim: one scheduled report per ISO week; an owner run is refused while one runs; a dead run is closed', { skip }, async () => {
  const repo = new AuditRepository(db.pool);
  const first = await repo.start('2026-W50', 'schedule', NOW);
  assert.ok(first);
  assert.equal(await repo.start('2026-W50', 'schedule', NOW), null, 'the same week twice');
  assert.equal(await repo.start('2026-W50', 'owner', NOW), null, 'refused while the first still runs');
  await repo.finish(first!.id, { findings: [], summary: null, llm: null, costUsd: 0 }, NOW);
  assert.equal(await repo.start('2026-W50', 'schedule', NOW), null, 'a finished week is still taken');
  const owner = await repo.start('2026-W50', 'owner', NOW);
  assert.ok(owner, 'an owner run after the finish');
  await repo.finish(owner!.id, { findings: [], summary: null, llm: null, costUsd: 0 }, NOW);
  // A run that never finished (a restart) stops blocking after the stale window.
  const dead = await repo.start('2026-W51', 'owner', NOW);
  assert.ok(dead);
  assert.equal(await repo.start('2026-W51', 'owner', new Date(NOW.getTime() + 60_000)), null);
  const later = await repo.start('2026-W51', 'owner', new Date(NOW.getTime() + STALE_RUN_MS + 60_000));
  assert.ok(later);
  assert.equal((await repo.get(dead!.id))!.status, 'failed');
  await repo.finish(later!.id, { findings: [], summary: null, llm: null, costUsd: 0 }, NOW);
});

test('run stores the open findings with the comments; apply and dismiss change one finding each', { skip }, async () => {
  clock = NOW;
  const s = setup([finding('a1'), finding('b2'), finding('c3', { fix: undefined })]);
  const run = await s.svc.run('schedule');
  assert.ok(run.ok);
  const report = (run as any).report;
  assert.equal(report.status, 'done');
  assert.equal(report.week, '2026-W43');
  assert.deepEqual(report.findings.map((f: any) => [f.key, f.status, f.comment ?? null]), [['a1', 'open', 'Comment'], ['b2', 'open', null], ['c3', 'open', null]]);
  assert.equal(report.costUsd, 0.01);

  const second = await s.svc.run('schedule');
  assert.deepEqual([second.ok, (second as any).error], [false, 'week_taken']);

  const ok = await s.svc.apply(report.id, 'a1');
  assert.ok(ok.ok);
  assert.deepEqual(s.calls[0], ['patchSkill', 'news', 'skill-a1', { enabled: false }]);
  const after1 = (await s.svc.get(report.id))!;
  assert.deepEqual(after1.findings.map((f) => f.status), ['applied', 'open', 'open']);
  assert.match(after1.findings[0].result!, /switched off/);

  const again = await s.svc.apply(report.id, 'a1');
  assert.deepEqual([again.ok, (again as any).error], [false, 'not_open']);
  const nofix = await s.svc.apply(report.id, 'c3');
  assert.deepEqual([nofix.ok, (nofix as any).error], [false, 'no_fix']);
  const missing = await s.svc.apply(report.id, 'zzz');
  assert.deepEqual([missing.ok, (missing as any).error], [false, 'finding_not_found']);

  const dis = await s.svc.dismiss(report.id, 'b2', 30);
  assert.ok(dis.ok);
  const after2 = (await s.svc.get(report.id))!;
  assert.equal(after2.findings[1].status, 'dismissed');
  assert.equal(after2.findings[1].dismissedUntil, new Date(NOW.getTime() + 30 * 86_400_000).toISOString());
  assert.equal(after2.findings[0].status, 'applied', 'the other findings stay as they were');
});

test('a failing fix marks the finding failed with the reason and can be tried again; a dismissed key stays out of the next report', { skip }, async () => {
  clock = new Date(NOW.getTime() + 7 * 86_400_000); // next week
  let fail = true;
  const s = setup([finding('d4'), finding('b2')], {
    patchSkill: async () => { if (fail) throw Object.assign(new Error('x'), { response: { error: 'skill_not_found', details: 'gone' } }); },
  });
  const run = await s.svc.run('schedule');
  const report = (run as any).report;
  assert.deepEqual(report.findings.map((f: any) => f.key), ['d4'], 'b2 was dismissed for 30 days last week');
  const bad = await s.svc.apply(report.id, 'd4');
  assert.deepEqual([bad.ok, (bad as any).error], [false, 'fix_failed']);
  assert.match((bad as any).details, /skill_not_found: gone/);
  assert.equal((await s.svc.get(report.id))!.findings[0].status, 'failed');
  fail = false;
  assert.ok((await s.svc.apply(report.id, 'd4')).ok, 'a failed finding may be applied again');
  assert.equal((await s.svc.get(report.id))!.findings[0].status, 'applied');
});

test('two clicks at once on different findings both stay; a pass that throws fails the report', { skip }, async () => {
  clock = new Date(NOW.getTime() + 14 * 86_400_000);
  const s = setup([finding('e5'), finding('f6')]);
  const report = ((await s.svc.run('schedule')) as any).report;
  await Promise.all([s.svc.apply(report.id, 'e5'), s.svc.dismiss(report.id, 'f6', 7)]);
  assert.deepEqual((await s.svc.get(report.id))!.findings.map((f) => f.status), ['applied', 'dismissed']);

  clock = new Date(NOW.getTime() + 21 * 86_400_000);
  const broken = new AuditService({ repo: new AuditRepository(db.pool), pass: async () => { throw new Error('facts failed'); }, fixes: {} as any, now: () => clock });
  const r = await broken.run('schedule');
  assert.deepEqual([r.ok, (r as any).error, (r as any).details], [false, 'run_failed', 'facts failed']);
  const failed = (await broken.list(1))[0];
  assert.deepEqual([failed.status, failed.error], ['failed', 'facts failed']);
});

test('the artifact adapter lists reports newest first with counts and opens one with its actions', { skip }, async () => {
  const repo = new AuditRepository(db.pool);
  const adapter = auditAdapter({ list: (n) => repo.list(n), get: (id) => repo.get(id) });
  const dir = { byHandle: new Map(), byId: new Map(), byRef: new Map() };
  const rows = await adapter.list({ limit: 10 } as any, dir);
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((r) => r.type === 'audit' && r.agent === 'sysadmin' && r.live === false));
  assert.deepEqual(rows.map((r) => r.id), (await repo.list(10)).map((r) => r.id), 'the repository order: newest started first');
  assert.deepEqual(await adapter.list({ limit: 10, channel: '@x' } as any, dir), []);
  const done = rows.find((r) => r.status === 'done')!;
  const got = await adapter.get(done.id, dir);
  assert.equal(got!.row.id, done.id);
  assert.deepEqual(adapter.actions(got!.row, got!.body), [{ key: 'run', label: 'Run again', method: 'POST', path: '/api/audits/run' }]);
  assert.equal(await adapter.get('00000000-0000-0000-0000-000000000000', dir), null);
});
