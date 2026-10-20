import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditTick, auditDue, auditInboxItem } from './audit-schedule';
import { auditLineOf, digestView, type KpiDigest } from '../manager/kpi-digest.service';
import { SETTINGS } from '../../settings/catalog';
import type { AuditReport, ReportFinding } from './audit-report';

// 2026-10-19 is a Monday; Kyiv is UTC+3 until 25 October.
const MON_0629 = new Date('2026-10-19T03:29:00Z');
const MON_0630 = new Date('2026-10-19T03:30:00Z');
const MON_NIGHT = new Date('2026-10-19T22:00:00Z');   // already Tuesday 01:00 in Kyiv
const TUE_0900 = new Date('2026-10-20T06:00:00Z');

const envOf = (o: Record<string, string> = {}) => (k: string) => o[k];

const f = (key: string, severity: 'info' | 'warn' | 'error', status: ReportFinding['status'] = 'open', fix = false): ReportFinding => ({
  key, area: 'skills', check: 'c', severity, subject: { type: 'skill', id: key, label: key }, title: key, detail: 'd', evidence: {}, status,
  ...(fix ? { fix: { kind: 'skill_disable' as const, agent: 'a', skill: 's' } } : {}),
});
const report = (findings: ReportFinding[], over: Partial<AuditReport> = {}): AuditReport => ({
  id: 'r-1', week: '2026-W43', trigger: 'schedule', status: 'done', findings, summary: null, llm: null, costUsd: 0, error: null,
  startedAt: '2026-10-19T03:30:00Z', finishedAt: '2026-10-19T03:31:00Z', ...over,
} as AuditReport);

test('due: Monday from 06:30 Kyiv by default; not before, not on another day', () => {
  assert.equal(auditDue(MON_0630, envOf()), '2026-W43');
  assert.equal(auditDue(MON_0629, envOf()), null);
  assert.equal(auditDue(TUE_0900, envOf()), null);
  // Late on Monday UTC is already Tuesday in Kyiv: the weekday is Kyiv's.
  assert.equal(auditDue(MON_NIGHT, envOf()), null);
});

test('due: the settings move the day and the hour, and off or a bad value never runs', () => {
  assert.equal(auditDue(TUE_0900, envOf({ AUDITOR_WEEKDAY: '2', AUDITOR_AT: '09:00' })), '2026-W43');
  assert.equal(auditDue(TUE_0900, envOf({ AUDITOR_WEEKDAY: '2', AUDITOR_AT: '09:01' })), null);
  assert.equal(auditDue(MON_0630, envOf({ AUDITOR_ENABLED: 'false' })), null);
  assert.equal(auditDue(MON_0630, envOf({ AUDITOR_WEEKDAY: '9' })), null);
  assert.equal(auditDue(MON_0630, envOf({ AUDITOR_AT: '6:30' })), null);
  assert.equal(auditDue(MON_0630, envOf({ AUDITOR_WEEKDAY: '1', AUDITOR_AT: '06:30', AUDITOR_ENABLED: 'true' })), '2026-W43');
});

test('the inbox note: nothing open, no note; an error makes it an action; counts, plural and the first summary line', () => {
  assert.equal(auditInboxItem(report([])), null);
  assert.equal(auditInboxItem(report([f('a', 'error', 'applied'), f('b', 'warn', 'dismissed')])), null);

  const one = auditInboxItem(report([f('a', 'warn', 'open', true)], { summary: 'Skills are fine.\nSecond line.' }))!;
  assert.equal(one.severity, 'info');
  assert.equal(one.kind, 'audit_report');
  assert.deepEqual([one.refType, one.refId], ['audit', 'r-1']);
  assert.equal(one.title, 'System audit: 1 open finding (0 errors), 1 fixable in one click');
  assert.equal(one.body, 'Skills are fine.');
  assert.equal(one.alert?.title, 'Аудит системи: 1 знахідка (0 помилок), 1 можна виправити одним кліком');
  assert.equal(one.alert?.body, 'Skills are fine.');

  const many = auditInboxItem(report([f('a', 'error'), f('b', 'error'), f('c', 'warn'), f('d', 'info'), f('e', 'info')]))!;
  assert.equal(many.severity, 'action');
  assert.equal(many.alert?.title, 'Аудит системи: 5 знахідок (2 помилки), 0 можна виправити одним кліком');
  assert.equal(many.body, null);

  const four = auditInboxItem(report([f('a', 'error'), f('b', 'warn'), f('c', 'warn'), f('d', 'info')]))!;
  assert.match(four.alert!.title, /4 знахідки \(1 помилка\)/);
});

function tickDeps(run: () => Promise<any>, env: Record<string, string> = {}, at: Date = MON_0630) {
  const posted: any[] = [];
  const runs: string[] = [];
  const logs: string[] = [];
  const deps = {
    svc: { run: async (t: any) => { runs.push(t); return run(); } },
    inbox: { postOnce: async (i: any): Promise<number | null> => { posted.push(i); return posted.length; } },
    env: envOf(env), now: () => at, log: (m: string) => { logs.push(m); },
  };
  return { deps, posted, runs, logs };
}

test('tick: not due runs nothing; due runs the scheduled audit once, posts the note and does not repeat in the week', async () => {
  const r = report([f('a', 'error', 'open', true)]);
  const off = tickDeps(async () => ({ ok: true, report: r }), {}, MON_0629);
  assert.deepEqual(await new AuditTick(off.deps as any).tick(), { ran: false, reason: 'not_due' });
  assert.deepEqual(off.runs, []);

  const t = tickDeps(async () => ({ ok: true, report: r }));
  const tick = new AuditTick(t.deps as any);
  assert.deepEqual(await tick.tick(), { ran: true, week: '2026-W43', reportId: 'r-1', posted: true });
  assert.deepEqual(t.runs, ['schedule']);
  assert.equal(t.posted.length, 1);
  assert.equal(t.posted[0].severity, 'action');
  assert.deepEqual(await tick.tick(), { ran: false, reason: 'done_this_week' });
  assert.equal(t.runs.length, 1);
});

test('tick: a clean report posts no note; a model-less report still posts the code findings', async () => {
  const clean = tickDeps(async () => ({ ok: true, report: report([]) }));
  assert.deepEqual(await new AuditTick(clean.deps as any).tick(), { ran: true, week: '2026-W43', reportId: 'r-1', posted: false });
  assert.equal(clean.posted.length, 0);
  const noModel = tickDeps(async () => ({ ok: true, report: report([f('a', 'warn')], { llm: { status: 'off', note: 'x', runId: null, costUsd: 0 } }) }));
  assert.equal(((await new AuditTick(noModel.deps as any).tick()) as any).posted, true);
});

test('tick: a week taken by another instance or a restart is a clean no-op, remembered; a running audit is retried', async () => {
  const taken = tickDeps(async () => ({ ok: false, error: 'week_taken' }));
  const tick = new AuditTick(taken.deps as any);
  assert.deepEqual(await tick.tick(), { ran: false, reason: 'week_taken' });
  assert.deepEqual(await tick.tick(), { ran: false, reason: 'done_this_week' });
  assert.equal(taken.runs.length, 1);
  assert.equal(taken.posted.length, 0);

  const busy = tickDeps(async () => ({ ok: false, error: 'already_running' }));
  const t2 = new AuditTick(busy.deps as any);
  assert.deepEqual(await t2.tick(), { ran: false, reason: 'already_running' });
  assert.deepEqual(await t2.tick(), { ran: false, reason: 'already_running' });
  assert.equal(busy.runs.length, 2);
});

test('tick: a failed run is logged and not retried that week; an inbox failure does not fail the tick', async () => {
  const failed = tickDeps(async () => ({ ok: false, error: 'run_failed', details: 'boom' }));
  const tick = new AuditTick(failed.deps as any);
  assert.deepEqual(await tick.tick(), { ran: false, reason: 'run_failed' });
  assert.match(failed.logs[0], /boom/);
  assert.deepEqual(await tick.tick(), { ran: false, reason: 'done_this_week' });

  const t = tickDeps(async () => ({ ok: true, report: report([f('a', 'warn')]) }));
  t.deps.inbox.postOnce = async () => { throw new Error('inbox down'); };
  assert.deepEqual(await new AuditTick(t.deps as any).tick(), { ran: true, week: '2026-W43', reportId: 'r-1', posted: false });
  assert.match(t.logs[0], /inbox down/);
});

test('the settings exist with the spec defaults and apply live', () => {
  const by = (k: string) => SETTINGS.find((s) => s.key === k)!;
  assert.deepEqual(['AUDITOR_ENABLED', 'AUDITOR_LLM', 'AUDITOR_WEEKDAY', 'AUDITOR_AT', 'AUDITOR_BUDGET_USD'].map((k) => [by(k).default, by(k).apply, by(k).group]),
    [['true', 'live', 'editor'], ['on', 'live', 'editor'], ['1', 'live', 'editor'], ['06:30', 'live', 'editor'], ['0.15', 'live', 'editor']]);
});

test('digest line: the newest finished report as open findings by severity; none when nothing is open or the table is missing', async () => {
  const pool = (rows: any[] | Error) => ({ query: async () => { if (rows instanceof Error) throw rows; return { rows }; } }) as any;
  const row = { id: 'r-9', week: '2026-W43', at: '2026-10-19T03:31:00Z', findings: [f('a', 'error'), f('b', 'warn', 'open', true), f('c', 'warn', 'dismissed')] };
  assert.deepEqual(await auditLineOf(pool([row])), { reportId: 'r-9', week: '2026-W43', at: '2026-10-19T03:31:00.000Z', open: 2, error: 1, warn: 1, info: 0, fixable: 1 });
  assert.equal(await auditLineOf(pool([{ ...row, findings: [f('c', 'warn', 'applied')] }])), null);
  assert.equal(await auditLineOf(pool([])), null);
  assert.equal(await auditLineOf(pool(new Error('relation "audit_reports" does not exist'))), null);
});

test('digest view carries the audit line in the head and leaves it out without one', () => {
  const base = {
    generatedAt: '2026-10-19T04:00:00Z', today: '2026-10-19', resources: [], agents: [],
    budget: { spentTodayUsd: 0, capUsd: 3 }, directives: { open: [], outcomes: [] }, hash: 'h', raw: new Map(),
  } as KpiDigest;
  const line = { reportId: 'r-9', week: '2026-W43', at: '2026-10-19T03:31:00.000Z', open: 2, error: 1, warn: 1, info: 0, fixable: 1 };
  assert.deepEqual(JSON.parse(digestView({ ...base, audit: line }).text).audit, line);
  assert.equal('audit' in JSON.parse(digestView(base).text), false);
});
