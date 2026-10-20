/**
 * Spec 055 T4 against a throwaway Postgres: the weekly tick claims the ISO week once (a second tick object, as after a
 * restart or on a second instance, runs nothing), the owner's inbox note is stored once with the Ukrainian alert, and the
 * manager digest line reads the newest finished report. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerInbox } from '../agents/owner-inbox';
import { auditLineOf } from '../manager/kpi-digest.service';
import { AuditRepository } from './audit-report';
import { AuditService } from './audit.service';
import { AuditTick } from './audit-schedule';
import type { AuditPass } from './auditor-runner';
import { emptyFacts, type Finding } from './audit.types';
import { createMigratedDb, type FreshDb } from './testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MON = new Date('2026-10-19T03:40:00Z'); // Monday 06:40 Kyiv, ISO week 2026-W43

let db: FreshDb;

const finding = (key: string, severity: 'info' | 'warn' | 'error'): Finding => ({
  key, area: 'skills', check: 'skill_unused', severity, subject: { type: 'skill', id: `id-${key}`, label: `skill-${key}`, agent: 'news' },
  title: `Finding ${key}`, detail: 'd', evidence: {}, fix: { kind: 'skill_disable', agent: 'news', skill: `skill-${key}` },
});
const pass = (findings: Finding[]): AuditPass => ({
  facts: emptyFacts(MON), findings, comments: {}, summary: 'The system is mostly fine.\nMore text.', llm: { status: 'off', note: 'off', runId: null, costUsd: 0 },
});

function tick(findings: Finding[], alerts: string[] = []) {
  const svc = new AuditService({
    repo: new AuditRepository(db.pool), pass: async () => pass(findings), now: () => MON,
    fixes: { agentByHandle: async () => null, patchSkill: async () => undefined, retireMemory: async () => false, applyConflicts: async () => ({ applied: [], remaining: [] }) },
  });
  const inbox = new OwnerInbox(db.pool, async (t) => { alerts.push(t); });
  return new AuditTick({ svc, inbox, env: () => undefined, now: () => MON });
}

before(async () => { if (url) db = await createMigratedDb(url, 't055s'); });
after(async () => { if (db) await db.drop(); });

test('the weekly tick claims the week once; a second tick object (restart, second instance) runs nothing; one inbox note', { skip }, async () => {
  const alerts: string[] = [];
  const first = await tick([finding('a', 'error'), finding('b', 'warn')], alerts).tick();
  assert.equal(first.ran, true);

  const again = await tick([finding('a', 'error'), finding('b', 'warn')], alerts).tick();
  assert.deepEqual(again, { ran: false, reason: 'week_taken' });

  const { rows: reports } = await db.pool.query(`SELECT week, trigger, status FROM audit_reports`);
  assert.deepEqual(reports, [{ week: '2026-W43', trigger: 'schedule', status: 'done' }]);

  const { rows: inbox } = await db.pool.query(`SELECT kind, severity, title, body, ref_type, ref_id FROM agent_inbox WHERE kind = 'audit_report'`);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].severity, 'action');
  assert.equal(inbox[0].title, 'System audit: 2 open findings (1 error), 2 fixable in one click');
  assert.equal(inbox[0].body, 'The system is mostly fine.');
  assert.equal(inbox[0].ref_type, 'audit');
  assert.match(inbox[0].ref_id, /^[0-9a-f-]{36}$/);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Аудит системи: 2 знахідки \(1 помилка\), 2 можна виправити одним кліком/);
});

test('the digest line reads the newest finished report and is gone when everything is handled', { skip }, async () => {
  const line = await auditLineOf(db.pool);
  assert.ok(line);
  assert.deepEqual([line!.week, line!.open, line!.error, line!.warn, line!.info, line!.fixable], ['2026-W43', 2, 1, 1, 0, 2]);
  const repo = new AuditRepository(db.pool);
  const latest = (await repo.latest())!;
  assert.equal(line!.reportId, latest.id);
  await repo.updateFinding(latest.id, 'a', (f) => ({ ...f, status: 'applied' }));
  await repo.updateFinding(latest.id, 'b', (f) => ({ ...f, status: 'dismissed' }));
  assert.equal(await auditLineOf(db.pool), null);
});
